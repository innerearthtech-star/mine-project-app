// ── In-memory state + all data mutations ───────────────────────────
// Every write: update memory → save to IndexedDB → queue in outbox →
// sync.js pushes to Supabase when we have signal.

import { DB } from './db.js';
import { CONFIG } from './config.js';
import { uuid, nowISO, emit } from './util.js';

export const S = {
  profile: null,      // {id, first, last, name, company, position, phone}
  owner: false,       // this device has unlocked the private Job tab
  ownerKey: null,     // stable key tagging private rows (derived from owner code)
  boreholes: [],
  notes: [],
  contacts: [],
  videos: [],
  users: [],          // roster: everyone using the app
  runs: [],
  shifts: [],
  jobs: [],
  settings: [],       // rows: {key, value, updated_at}
};

// Tables whose rows are private to the owner (runs / hours / night stays)
export const PRIVATE_TABLES = new Set(['runs', 'shifts', 'jobs']);
// Local store name for each synced table (Supabase table 'app_settings' ⇔ local 'settings')
const LOCAL_STORE = t => (t === 'app_settings' ? 'settings' : t);
export const SYNCED_TABLES = ['boreholes', 'notes', 'contacts', 'videos', 'users', 'runs', 'shifts', 'jobs', 'app_settings'];

export async function loadAll() {
  S.profile = (await DB.kvGet('profile')) || null;
  S.owner = (await DB.kvGet('owner')) === true;
  S.ownerKey = (await DB.kvGet('ownerKey')) || null;
  S.boreholes = await DB.all('boreholes');
  S.notes = await DB.all('notes');
  S.contacts = await DB.all('contacts');
  S.videos = await DB.all('videos');
  S.users = await DB.all('users');
  S.runs = await DB.all('runs');
  S.shifts = await DB.all('shifts');
  S.jobs = await DB.all('jobs');
  S.settings = await DB.all('settings');
}

function memList(table) { return S[LOCAL_STORE(table)]; }
const keyOf = (table, row) => (table === 'app_settings' ? row.key : row.id);

function putMem(table, row) {
  const list = memList(table);
  const k = keyOf(table, row);
  const i = list.findIndex(r => keyOf(table, r) === k);
  if (i >= 0) list[i] = row; else list.push(row);
}
export function findRow(table, key) {
  return memList(table).find(r => keyOf(table, r) === key);
}

// ── Writes (local user actions) ────────────────────────────────────
let outboxSeq = 0; // tie-breaker so same-millisecond writes push in order
export async function save(table, row) {
  // Monotonic timestamp: a deliberate local edit must always out-rank the
  // value the row already carries — even if that value was stamped by
  // another device whose clock runs ahead of this one. Without this, a
  // re-registering removed user on a slow clock could lose to the owner's
  // newer "deleted" row and get bounced to sign-up on a loop.
  const prev = findRow(table, keyOf(table, row));
  let ts = nowISO();
  if (prev && String(prev.updated_at || '') >= ts) {
    ts = new Date(Date.parse(prev.updated_at) + 1).toISOString();
  }
  row.updated_at = ts;
  putMem(table, row);
  await DB.putAll([
    [LOCAL_STORE(table), row],
    ['outbox', { id: uuid(), ts: Date.now(), seq: ++outboxSeq, attempts: 0, table, row: { ...row } }],
  ]);
  emit('data:' + table, row);
  emit('outbox');
}

export async function softDelete(table, row) {
  await save(table, { ...row, deleted: true });
}

// ── Merges (rows arriving from Supabase pull / realtime) ───────────
export async function mergeRemote(table, row) {
  if (!row) return;
  if (PRIVATE_TABLES.has(table)) {
    if (!S.owner || row.owner_key !== S.ownerKey) return; // not my private data
  }
  const local = findRow(table, keyOf(table, row));
  if (local && String(local.updated_at || '') >= String(row.updated_at || '')) return;
  putMem(table, row);
  await DB.put(LOCAL_STORE(table), row);
  emit('data:' + table, row);
}

// ── Convenience accessors ──────────────────────────────────────────
export const activeBoreholes = () =>
  S.boreholes.filter(b => !b.deleted).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
export const notesFor = id =>
  S.notes.filter(n => n.borehole_id === id && !n.deleted)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
export const activeContacts = () =>
  S.contacts.filter(c => !c.deleted)
    .sort((a, b) => (a.company + a.name).localeCompare(b.company + b.name));
export const activeUsers = () =>
  S.users.filter(u => !u.deleted)
    .sort((a, b) => (a.company + a.name).localeCompare(b.company + b.name));
export const activeVideos = () =>
  S.videos.filter(v => !v.deleted).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
export const videosFor = id =>
  activeVideos().filter(v => v.borehole_id === id);
export const activeRuns = () =>
  S.runs.filter(r => !r.deleted).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
export const activeShifts = () =>
  S.shifts.filter(s => !s.deleted).sort((a, b) => String(b.start_ts).localeCompare(String(a.start_ts)));
export const activeJobs = () =>
  S.jobs.filter(j => !j.deleted).sort((a, b) => String(b.night_start).localeCompare(String(a.night_start)));
export const openShift = () => activeShifts().find(s => !s.end_ts);
export const currentJob = () => activeJobs().find(j => !j.night_end);

export function getSetting(key) {
  const r = S.settings.find(s => s.key === key && !s.deleted);
  return r ? r.value : undefined;
}
export const setSetting = (key, value) => save('app_settings', { key, value });
export const projectName = () => getSetting('project_name') || CONFIG.DEFAULT_PROJECT_NAME;

// ── Entity creators ────────────────────────────────────────────────
export async function newBorehole(name, lat, lng) {
  const row = {
    id: uuid(), name, lat, lng, photo: null,
    created_by: S.profile.name, author_id: S.profile.id,
    created_at: nowISO(), deleted: false,
  };
  await save('boreholes', row);
  return row;
}
export function newNote(boreholeId, text, photos = []) {
  return save('notes', {
    id: uuid(), borehole_id: boreholeId, text, photos,
    author: S.profile.name, author_id: S.profile.id,
    created_at: nowISO(), deleted: false,
  });
}
export function newContact(company, name, phone, position = '') {
  return save('contacts', {
    id: uuid(), company, name, phone, position,
    created_by: S.profile.name, author_id: S.profile.id,
    created_at: nowISO(), deleted: false,
  });
}
export function newVideo(boreholeId, ts, note, path, size, screenshots = []) {
  return save('videos', {
    id: uuid(), borehole_id: boreholeId, ts, note: note || '',
    path: path || null, size: size || 0, screenshots,
    uploaded_by: S.profile.name, author_id: S.profile.id,
    created_at: nowISO(), deleted: false,
  });
}
export function newRun(boreholeId, ts, note = '') {
  return save('runs', {
    id: uuid(), borehole_id: boreholeId, ts, note,
    owner_key: S.ownerKey, created_at: nowISO(), deleted: false,
  });
}
export function newShift(startTs) {
  return save('shifts', {
    id: uuid(), start_ts: startTs, end_ts: null,
    owner_key: S.ownerKey, created_at: nowISO(), deleted: false,
  });
}
export function newJob(nightStart) {
  return save('jobs', {
    id: uuid(), night_start: nightStart, night_end: null,
    owner_key: S.ownerKey, created_at: nowISO(), deleted: false,
  });
}

// ── Profile / roster ───────────────────────────────────────────────
// data = {first, last, company, position, phone}. Stores the profile
// locally AND upserts this person's row into the shared roster so the
// owner can see (and remove) who's on the app.
export async function saveProfile(data) {
  const id = S.profile?.id || uuid();
  const first = data.first.trim(), last = data.last.trim();
  S.profile = {
    id, first, last,
    name: `${first} ${last}`.trim(),
    company: (data.company || '').trim(),
    position: (data.position || '').trim(),
    phone: data.phone || '',
  };
  await DB.kvSet('profile', S.profile);
  await save('users', {
    id, first, last, name: S.profile.name,
    company: S.profile.company, position: S.profile.position, phone: S.profile.phone,
    created_at: findRow('users', id)?.created_at || nowISO(),
    deleted: false,
  });
  emit('profile');
}

// Owner removes someone from the roster.
export async function removeUser(id) {
  const u = findRow('users', id);
  if (u) await softDelete('users', u);
}

// Sign back in as an existing crew member (e.g. after installing the app,
// which on iOS gets fresh storage separate from the browser). Re-adopts
// their identity + roster row so no duplicate is created.
export async function resumeAs(userId) {
  const u = findRow('users', userId);
  if (!u) return false;
  S.profile = {
    id: u.id, first: u.first, last: u.last, name: u.name,
    company: u.company || '', position: u.position || '', phone: u.phone || '',
  };
  await DB.kvSet('profile', S.profile);
  await save('users', { ...u, deleted: false }); // reaffirm they're active
  emit('profile');
  return true;
}

// True if the owner has removed *this* device's user from the roster.
export function iAmRemoved() {
  const me = S.profile && findRow('users', S.profile.id);
  return Boolean(me && me.deleted);
}
export async function unlockOwner(ownerKey) {
  S.owner = true;
  S.ownerKey = ownerKey;
  await DB.kvSet('owner', true);
  await DB.kvSet('ownerKey', ownerKey);
  emit('owner');
}
export async function lockOwner() {
  S.owner = false;
  await DB.kvSet('owner', false);
  emit('owner');
}

// ── Photos (blobs stored locally, uploaded by sync) ────────────────
export async function addPhotoBlob(path, blob) {
  await DB.put('photos', { path, blob, uploaded: false, ts: Date.now() });
  emit('outbox');
}

const objURLs = new Map();
export async function photoURL(path) {
  if (!path) return null;
  if (objURLs.has(path)) return objURLs.get(path);
  const rec = await DB.get('photos', path);
  if (rec && rec.blob) {
    const u = URL.createObjectURL(rec.blob);
    objURLs.set(path, u);
    return u;
  }
  if (CONFIG.SUPABASE_URL) {
    return `${CONFIG.SUPABASE_URL}/storage/v1/object/public/photos/${path}`;
  }
  return null;
}
