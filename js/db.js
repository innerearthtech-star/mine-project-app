// ── IndexedDB wrapper: everything the app knows lives here first ───
// (offline-first: writes land here immediately, sync.js pushes later)

const DB_NAME = 'coalmine-app';
const DB_VER = 2; // v2: videos store
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name, keyPath) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      };
      mk('kv', 'key');           // profile, owner flag, map view, misc
      mk('boreholes', 'id');
      mk('notes', 'id');
      mk('contacts', 'id');
      mk('videos', 'id');       // metadata only — the files live in Supabase
      mk('runs', 'id');
      mk('shifts', 'id');
      mk('jobs', 'id');
      mk('settings', 'key');     // shared app settings (project name, …)
      mk('outbox', 'id');        // pending writes waiting for signal
      mk('photos', 'path');      // {path, blob, uploaded}
    };
    req.onblocked = () => {
      dbp = null;
      reject(new Error('App update blocked — close other tabs of this app, then reload.'));
    };
    req.onsuccess = () => {
      const db = req.result;
      // let a future version upgrade in another tab proceed instead of hanging
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const DB = {
  init: () => open(),

  get: (store, key) => open().then(db => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  })),

  all: store => open().then(db => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  })),

  put: (store, obj) => tx(store, 'readwrite', s => s.put(obj)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),

  // Atomic multi-store write: all pairs commit in one transaction, so a
  // mid-write crash can never save a row without its outbox entry.
  putAll: pairs => open().then(db => new Promise((res, rej) => {
    const t = db.transaction([...new Set(pairs.map(p => p[0]))], 'readwrite');
    for (const [store, obj] of pairs) t.objectStore(store).put(obj);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  })),

  kvGet: key => DB.get('kv', key).then(r => (r ? r.value : undefined)),
  kvSet: (key, value) => DB.put('kv', { key, value }),
};
