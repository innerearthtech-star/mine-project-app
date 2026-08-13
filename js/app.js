// ── Boot, welcome screen, tab navigation, header status ────────────

import { $, $$, esc, on, toast } from './util.js';
import { CONFIG } from './config.js';
import { DB } from './db.js';
import { S, loadAll, setProfile, projectName } from './store.js';
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

  if (!S.profile) showWelcome();
  else startApp();
}

function showWelcome() {
  $('#welcome').classList.add('show');
  $('#welcome-title').textContent = `${projectName()} Project`;
  const form = $('#welcome-form');
  form.onsubmit = async e => {
    e.preventDefault();
    const name = $('#welcome-name').value.trim();
    if (!name) return;
    await setProfile(name);
    $('#welcome').classList.remove('show');
    startApp();
    toast(`Welcome, ${name} — pins you add show your name`, 'ok');
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
