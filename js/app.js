// ── Boot, welcome screen, tab navigation, header status ────────────

import { $, $$, esc, on, toast, normalizePhone } from './util.js';
import { CONFIG } from './config.js';
import { DB } from './db.js';
import { S, loadAll, saveProfile, projectName, iAmRemoved } from './store.js';
import { initSync, syncState } from './sync.js';
import { initMap, refreshMapSize } from './map.js';
import { initJob, renderJob } from './job.js';
import { initContacts, renderContacts } from './contacts.js';
import { initSettings, renderSettings } from './settings.js';
import { initVideos, renderVideoList, refreshUploadDefaults } from './videos.js';

let currentTab = 'map';

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  try {
    await DB.init();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px 24px;font-family:sans-serif;color:#e8eef4;background:#0b0f14;min-height:100vh">
      <h2>Can't start</h2><p>${e.message || e}</p></div>`;
    return;
  }
  // ask the browser to protect our storage from eviction — this phone's
  // unsynced pins/notes/hours live in IndexedDB until signal returns
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  await loadAll();
  await initSync();

  initJob();
  initContacts();
  initSettings();
  initVideos();

  on('data:app_settings', renderHeader);
  on('sync', renderHeader);
  on('owner', updateTabs);
  on('profile', renderHeader);
  // if the owner removes this person, drop them back to the sign-up screen
  on('data:users', () => {
    if (S.profile && !S.owner && iAmRemoved() && $('#app').classList.contains('show')) {
      $('#app').classList.remove('show');
      showWelcome({ removed: true });
    }
  });

  // need sign-up if: never registered, missing the newer fields, or removed
  const incomplete = S.profile && (!S.profile.first || !S.profile.phone);
  if (!S.profile || incomplete || (iAmRemoved() && !S.owner)) {
    showWelcome({ removed: Boolean(S.profile && iAmRemoved()) });
  } else {
    startApp();
  }
}

function showWelcome({ removed = false } = {}) {
  const wrap = $('#welcome');
  wrap.classList.add('show');
  $('#welcome-title').textContent = `${projectName()} Project`;

  // pre-fill if we already know this person (re-joining after removal / edit)
  const p = S.profile;
  if (p) {
    $('#w-first').value = p.first || '';
    $('#w-last').value = p.last || '';
    $('#w-company').value = p.company || '';
    $('#w-position').value = p.position || '';
    $('#w-phone').value = p.phone || '';
  }
  const err = $('#w-error');
  if (removed) {
    err.hidden = false;
    err.textContent = 'The site owner removed your access. Re-enter your details to rejoin.';
  } else {
    err.hidden = true;
  }

  const form = $('#welcome-form');
  form.onsubmit = async e => {
    e.preventDefault();
    const first = $('#w-first').value.trim();
    const last = $('#w-last').value.trim();
    const company = $('#w-company').value.trim();
    const position = $('#w-position').value.trim();
    const phoneRaw = $('#w-phone').value.trim();
    if (!first || !last || !company || !position) {
      err.hidden = false; err.textContent = 'Please fill in every field.'; return;
    }
    const phone = normalizePhone(phoneRaw);
    if (!phone) {
      err.hidden = false; err.textContent = 'Enter a valid 10-digit cell number.';
      $('#w-phone').focus(); return;
    }
    await saveProfile({ first, last, company, position, phone });
    wrap.classList.remove('show');
    startApp();
    toast(`Welcome, ${first} — pins you add show your name`, 'ok');
  };
}

function startApp() {
  $('#app').classList.add('show');
  renderHeader();
  updateTabs();
  wireTabs();
  showTab('map');
  renderContacts();
  renderSettings();
  if (S.owner) renderJob();
}

function renderHeader() {
  $('#header-title').textContent = `${projectName()} Project`;
  const st = syncState;
  const dot = $('#sync-dot');
  dot.className = 'dot ' + (!st.configured ? 'dot-gray' : !st.online ? 'dot-red' : st.pending ? 'dot-amber' : 'dot-green');
  dot.title = !st.configured ? 'Local only' : !st.online ? 'Offline' : st.pending ? `${st.pending} pending` : 'Synced';
}

function updateTabs() {
  $('#tab-job').style.display = S.owner ? '' : 'none';
  if (!S.owner && currentTab === 'job') showTab('map');
  if (S.owner) renderJob();
}

function wireTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.onclick = () => showTab(btn.dataset.tab);
  });
}

function showTab(name) {
  currentTab = name;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'map') { initMap(); refreshMapSize(); }
  if (name === 'videos') { refreshUploadDefaults(); renderVideoList(); }
  if (name === 'job') renderJob();
  if (name === 'contacts') renderContacts();
  if (name === 'settings') renderSettings();
}

boot();
