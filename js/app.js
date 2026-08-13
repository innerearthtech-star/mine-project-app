// ── Boot, welcome screen, tab navigation, header status ────────────

import { $, $$, esc, on, toast, normalizePhone, closeSheet, closeModal } from './util.js';
import { CONFIG } from './config.js';
import { DB } from './db.js';
import { S, loadAll, saveProfile, projectName, iAmRemoved, activeUsers, resumeAs } from './store.js';
import { initSync, syncState } from './sync.js';
import { initMap, refreshMapSize } from './map.js';
import { initJob, renderJob } from './job.js';
import { initContacts, renderContacts } from './contacts.js';
import { initSettings, renderSettings } from './settings.js';
import { initVideos, renderVideoList, refreshUploadDefaults } from './videos.js';

let currentTab = 'map';

async function boot() {
  setupServiceWorker();
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
  // if the owner removes this person, drop them back to the sign-up screen;
  // and keep the "tap your name" list fresh as crew syncs in
  on('data:users', () => {
    if (S.profile && !S.owner && iAmRemoved() && $('#app').classList.contains('show')) {
      $('#app').classList.remove('show');
      showWelcome({ removed: true });
    }
    if ($('#welcome').classList.contains('show') && welcomeRenderResume) welcomeRenderResume();
  });

  // need sign-up if: never registered, missing the newer fields, or removed
  const incomplete = S.profile && (!S.profile.first || !S.profile.phone);
  if (!S.profile || incomplete || (iAmRemoved() && !S.owner)) {
    showWelcome({ removed: Boolean(S.profile && iAmRemoved()) });
  } else {
    startApp();
  }
}

let welcomeRenderResume = null; // lets the data:users handler refresh the list

function showWelcome({ removed = false } = {}) {
  // tear down any open well sheet / dialog before returning to sign-up
  closeSheet();
  closeModal();
  const wrap = $('#welcome');
  wrap.classList.add('show');
  $('#welcome-title').textContent = `${projectName()} Project`;

  const gated = Boolean(CONFIG.JOIN_CODE);
  const codeInput = $('#w-code');
  const codeWrap = $('#w-code-wrap');
  if (codeWrap) codeWrap.style.display = gated ? '' : 'none';
  const codeOk = () => !gated || (codeInput && codeInput.value.trim() === CONFIG.JOIN_CODE);

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
  const setErr = msg => {
    if (msg) { err.hidden = false; err.textContent = msg; } else { err.hidden = true; }
  };
  setErr(removed ? 'The site owner removed your access. Re-enter your details to rejoin.' : '');

  // "Tap your name" list — only rendered once the access code is right, so
  // a random with the link never sees the roster. Lets returning users
  // (e.g. after installing the app, which gets fresh storage) sign back in
  // without retyping everything.
  const renderResume = () => {
    const box = $('#welcome-resume');
    if (!box) return;
    const users = codeOk() ? activeUsers() : [];
    if (!users.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="resume-title">Already signed up? Tap your name</div>
      <div class="resume-list">
        ${users.map(u => `<button class="resume-row" data-uid="${esc(u.id)}">
          <span class="resume-name">${esc(u.name)}</span>
          <span class="resume-co">${esc(u.company || '')}</span></button>`).join('')}
      </div>
      <div class="resume-or">— or add yourself below —</div>`;
    $$('.resume-row', box).forEach(btn => btn.onclick = async () => {
      await resumeAs(btn.dataset.uid);
      wrap.classList.remove('show');
      startApp();
      toast(`Welcome back, ${S.profile.first}`, 'ok');
    });
  };
  welcomeRenderResume = renderResume;
  renderResume();

  if (codeInput) codeInput.oninput = () => { renderResume(); if (codeOk()) setErr(''); };

  const form = $('#welcome-form');
  form.onsubmit = async e => {
    e.preventDefault();
    if (gated && codeInput.value.trim() !== CONFIG.JOIN_CODE) {
      setErr('Wrong access code — ask whoever shared the app.');
      codeInput.focus();
      return;
    }
    const first = $('#w-first').value.trim();
    const last = $('#w-last').value.trim();
    const company = $('#w-company').value.trim();
    const position = $('#w-position').value.trim();
    if (!first || !last || !company || !position) { setErr('Please fill in every field.'); return; }
    const phone = normalizePhone($('#w-phone').value.trim());
    if (!phone) { setErr('Enter a valid 10-digit cell number.'); $('#w-phone').focus(); return; }
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

// ── Service worker + "new version" bar ─────────────────────────────
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let updating = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // only reload when WE triggered the update (not on the very first install)
    if (updating) location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then(reg => {
    const offerUpdate = worker => {
      const bar = $('#update-bar');
      if (!bar || !worker) return;
      bar.classList.add('show');
      $('#update-btn').onclick = () => {
        updating = true;
        $('#update-btn').disabled = true;
        $('#update-btn').textContent = 'Updating…';
        worker.postMessage('SKIP_WAITING');
      };
      $('#update-dismiss').onclick = () => bar.classList.remove('show');
    };
    // an update was already downloaded and is waiting
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    // a new version shows up while the app is open
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw);
      });
    });
    // check for a new deploy periodically and whenever the app is refocused
    setInterval(() => reg.update().catch(() => {}), 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

boot();
