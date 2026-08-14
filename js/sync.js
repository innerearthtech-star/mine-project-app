// ── Supabase sync engine ───────────────────────────────────────────
// Push queued local writes, upload photos, pull everything, and keep
// a realtime subscription open so other crews' pins appear live.

import { CONFIG } from './config.js';
import { DB } from './db.js';
import { S, SYNCED_TABLES, PRIVATE_TABLES, mergeRemote, amIApproved } from './store.js';
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
  dropped: 0, // writes given up on after repeated data errors (never auto-reset)
};

export function isConfigured() {
  return Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase);
}

// Direct storage access for the video tab's uploads (null until configured)
export const getClient = () => client;

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
// Pull ALWAYS runs even when push/upload fails — a stuck upload must never
// stop this phone from receiving the crew's pins and notes.
export async function kick() {
  if (!client || !navigator.onLine) return;
  if (syncing) { queued = true; return; }
  syncing = true;
  syncState.error = null;
  try {
    try {
      await pushOutbox();
      await uploadPhotos();
    } catch (e) {
      console.warn('push/upload failed', e);
      syncState.error = e.message || String(e);
    }
    await pullAll();
    await prunePhotoBlobs();
    syncState.lastSync = Date.now();
  } catch (e) {
    console.warn('sync failed', e);
    syncState.error = syncState.error || e.message || String(e);
  } finally {
    await refreshPending();
    syncing = false;
    emit('sync');
    if (queued) { queued = false; kick(); }
  }
}

async function pushOutbox() {
  const ops = (await DB.all('outbox')).sort((a, b) => (a.ts - b.ts) || ((a.seq || 0) - (b.seq || 0)));
  for (const op of ops) {
    const { error } = await client.from(op.table).upsert(op.row);
    if (!error) {
      await DB.del('outbox', op.id);
      continue;
    }
    // Only definitive data errors (Postgres constraint/data/syntax classes,
    // PostgREST request + schema-cache errors like a missing column) count
    // toward the drop limit. Anything else — 5xx, rate limits, HTML error
    // pages, paused project, offline — is transient: stop and retry next
    // cycle so field data is never discarded.
    const code = String(error.code || '');
    const isDataError = /^(22|23|42)\d{3}$/.test(code) || /^PGRST[12]\d\d$/.test(code);
    if (!isDataError) throw new Error(`push failed (will retry): ${error.message}`);
    op.attempts = (op.attempts || 0) + 1;
    if (op.attempts >= 5) {
      console.error('dropping unsyncable row after 5 attempts', op, error);
      syncState.dropped++;
      await DB.del('outbox', op.id);
    } else {
      await DB.put('outbox', op);
      // do NOT throw — one bad row must not block the rest of the queue
      // (e.g. a depth edit before the DB columns exist shouldn't stall pins)
    }
  }
}

async function uploadPhotos() {
  const photos = (await DB.all('photos')).filter(p => !p.uploaded);
  for (const p of photos) {
    const { error } = await client.storage.from('photos')
      .upload(p.path, p.blob, { contentType: 'image/jpeg', upsert: true });
    if (!error || String(error.message).toLowerCase().includes('exist')) {
      p.uploaded = true;
      await DB.put('photos', p);
      continue;
    }
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout')) {
      throw new Error('offline during photo upload');
    }
    // Data problem with this one photo — don't let it block the others.
    p.attempts = (p.attempts || 0) + 1;
    if (p.attempts >= 5) {
      console.error('dropping photo after 5 failed uploads', p.path, error);
      syncState.dropped++;
      await DB.del('photos', p.path);
    } else {
      await DB.put('photos', p);
      syncState.error = `photo upload failed: ${error.message}`;
    }
  }
}

// Uploaded photo blobs older than a week come out of local storage — the
// public bucket URL (cached by the service worker once viewed) covers them.
async function prunePhotoBlobs() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const p of await DB.all('photos')) {
    if (p.uploaded && (p.ts || 0) < cutoff) await DB.del('photos', p.path);
  }
}

async function pullAll() {
  const PAGE = 1000; // PostgREST caps responses; page so nothing is missed
  for (const table of SYNCED_TABLES) {
    // waiting-room devices only fetch the roster + project name
    if (!amIApproved() && table !== 'users' && table !== 'app_settings') continue;
    const isPrivate = PRIVATE_TABLES.has(table);
    if (isPrivate && (!S.owner || !S.ownerKey)) continue;
    const pk = table === 'app_settings' ? 'key' : 'id';
    for (let from = 0; ; from += PAGE) {
      let q = client.from(table).select('*').order(pk).range(from, from + PAGE - 1);
      if (isPrivate) q = q.eq('owner_key', S.ownerKey);
      const { data, error } = await q;
      if (error) throw new Error(`pull ${table}: ${error.message}`);
      for (const row of data) await mergeRemote(table, row);
      if (data.length < PAGE) break;
    }
  }
}
