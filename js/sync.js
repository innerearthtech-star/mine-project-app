// ── Supabase sync engine ───────────────────────────────────────────
// Push queued local writes, upload photos, pull everything, and keep
// a realtime subscription open so other crews' pins appear live.

import { CONFIG } from './config.js';
import { DB } from './db.js';
import { S, SYNCED_TABLES, PRIVATE_TABLES, mergeRemote } from './store.js';
import { emit, on } from './util.js';

let client = null;
let syncing = false;
let queued = false;

export const syncState = {
  configured: false,
  online: navigator.onLine,
  pending: 0,
  lastSync: null,
  error: null,
};

export function isConfigured() {
  return Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase);
}

export async function initSync() {
  syncState.configured = isConfigured();
  await refreshPending();

  window.addEventListener('online', () => { syncState.online = true; emit('sync'); kick(); });
  window.addEventListener('offline', () => { syncState.online = false; emit('sync'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  on('outbox', () => { refreshPending().then(() => emit('sync')); kick(); });
  on('owner', () => kick());

  if (!syncState.configured) { emit('sync'); return; }

  client = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

  client.channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public' }, payload => {
      if (payload.new && payload.table) mergeRemote(payload.table, payload.new);
    })
    .subscribe();

  setInterval(kick, 45000);
  kick();
}

async function refreshPending() {
  const outbox = await DB.all('outbox');
  const photos = await DB.all('photos');
  syncState.pending = outbox.length + photos.filter(p => !p.uploaded).length;
}

// Run one full sync cycle; coalesce extra requests instead of overlapping.
export async function kick() {
  if (!client || !navigator.onLine) return;
  if (syncing) { queued = true; return; }
  syncing = true;
  syncState.error = null;
  try {
    await pushOutbox();
    await uploadPhotos();
    await pullAll();
    syncState.lastSync = Date.now();
  } catch (e) {
    console.warn('sync failed', e);
    syncState.error = e.message || String(e);
  } finally {
    await refreshPending();
    syncing = false;
    emit('sync');
    if (queued) { queued = false; kick(); }
  }
}

async function pushOutbox() {
  const ops = (await DB.all('outbox')).sort((a, b) => a.ts - b.ts);
  for (const op of ops) {
    const { error } = await client.from(op.table).upsert(op.row);
    if (!error) {
      await DB.del('outbox', op.id);
      continue;
    }
    // Network-ish problem → stop, retry next cycle. Data problem → count
    // attempts so one bad row can't block the queue forever.
    const msg = (error.message || '').toLowerCase();
    const isNetwork = msg.includes('fetch') || msg.includes('network') || msg.includes('timeout');
    if (isNetwork) throw new Error('offline during push');
    op.attempts = (op.attempts || 0) + 1;
    if (op.attempts >= 5) {
      console.error('dropping unsyncable row after 5 attempts', op, error);
      await DB.del('outbox', op.id);
    } else {
      await DB.put('outbox', op);
      throw new Error(`push failed: ${error.message}`);
    }
  }
}

async function uploadPhotos() {
  const photos = (await DB.all('photos')).filter(p => !p.uploaded);
  for (const p of photos) {
    const { error } = await client.storage.from('photos')
      .upload(p.path, p.blob, { contentType: 'image/jpeg', upsert: true });
    // "already exists" counts as success (upsert covers it, but be safe)
    if (error && !String(error.message).toLowerCase().includes('exist')) {
      throw new Error(`photo upload failed: ${error.message}`);
    }
    p.uploaded = true;
    await DB.put('photos', p);
  }
}

async function pullAll() {
  for (const table of SYNCED_TABLES) {
    if (PRIVATE_TABLES.has(table)) {
      if (!S.owner || !S.ownerKey) continue;
      const { data, error } = await client.from(table).select('*').eq('owner_key', S.ownerKey);
      if (error) throw new Error(`pull ${table}: ${error.message}`);
      for (const row of data) await mergeRemote(table, row);
    } else {
      const { data, error } = await client.from(table).select('*');
      if (error) throw new Error(`pull ${table}: ${error.message}`);
      for (const row of data) await mergeRemote(table, row);
    }
  }
}
