// ── Boot, welcome screen, tab navigation, header status ────────────

import { $, $$, esc, on, toast, normalizePhone, closeSheet, closeModal, modalForm } from './util.js';
import { CONFIG } from './config.js';
import { DB } from './db.js';
import {
  S, loadAll, saveProfile, projectName, iAmRemoved, activeUsers, resumeAs,
  checkUserPin, setUserPin, findUnusedInvite, consumeInvite, canISeeVideos,
} from './store.js';
import { initSync, syncState, getClient } from './sync.js';
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
      return;
    }
    if ($('#welcome').classList.contains('show') && welcomeRenderResume) welcomeRenderResume();
    // granted/revoked permissions (videos tab) arrive via the roster
    if ($('#app').classList.contains('show')) updateTabs();
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
let pendingInvite = null;       // unused invite row to consume on sign-up

// An invite code is valid if it exists and nobody has used it. Fresh
// installs have nothing synced yet, so fall back to asking the server.
async function validateInviteCode(code) {
  const c = (code || '').trim().toUpperCase();
  if (!c) return null;
  const local = findUnusedInvite(c);
  if (local) return local;
  const client = getClient();
  if (!client) return null;
  try {
    const { data } = await client.from('invites').select('*')
      .eq('code', c).eq('deleted', false).is('used_by', null).limit(1);
    return (data && data[0]) || null;
  } catch { return null; }
}

function showWelcome({ removed = false } = {}) {
  // tear down any open well sheet / dialog before returning to sign-up
  closeSheet();
  closeModal();
  const wrap = $('#welcome');
  wrap.classList.add('show');
  $('#welcome-title').textContent = `${projectName()} Project`;

  const gated = Boolean(CONFIG.JOIN_CODE);
  const gateForm = $('#gate-form');
  const main = $('#welcome-main');
  const msg = $('#welcome-msg');
  const setMsg = m => { if (m) { msg.hidden = false; msg.textContent = m; } else { msg.hidden = true; } };
  setMsg(removed ? 'The site owner removed your access. Sign back in to rejoin.' : '');

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
  const setErr = m => { if (m) { err.hidden = false; err.textContent = m; } else { err.hidden = true; } };
  setErr('');

  // "Tap your name" — front and center once past the access code, so
  // returning users (fresh install = fresh storage on iPhone) never
  // retype their details.
  const renderResume = () => {
    const box = $('#welcome-resume');
    if (!box || main.hidden) return;
    const users = activeUsers();
    if (!users.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="resume-title">Already signed up? Tap your name</div>
      <div class="resume-list">
        ${users.map(u => `<button class="resume-row" data-uid="${esc(u.id)}">
          <span class="resume-name">${esc(u.name)}</span>
          <span class="resume-co">${esc(u.company || '')}</span></button>`).join('')}
      </div>
      <div class="resume-or">— or —</div>`;
    $$('.resume-row', box).forEach(btn => btn.onclick = async () => {
      const u = activeUsers().find(x => x.id === btn.dataset.uid);
      if (!u) return;
      if (u.pin) {
        // account is PIN-protected — verify it's really them
        const res = await modalForm({
          title: `Hi ${u.first} — enter your PIN`,
          fields: [{ name: 'pin', label: '4-digit PIN', type: 'password', inputmode: 'numeric', required: true }],
          okText: 'Sign in',
        });
        if (!res) return;
        if (!await checkUserPin(u, (res.pin || '').trim())) { toast('Wrong PIN', 'warn'); return; }
        await resumeAs(u.id);
      } else {
        // account made before PINs existed — set one now, first-come
        const res = await modalForm({
          title: `Hi ${u.first} — set your PIN`,
          fields: [{ name: 'pin', label: 'Create a 4-digit PIN', type: 'password', inputmode: 'numeric', required: true }],
          okText: 'Set PIN & sign in',
        });
        if (!res) return;
        const pin = (res.pin || '').trim();
        if (!/^\d{4}$/.test(pin)) { toast('PIN must be exactly 4 digits', 'warn'); return; }
        await resumeAs(u.id);
        await setUserPin(u.id, pin);
      }
      wrap.classList.remove('show');
      startApp();
      toast(`Welcome back, ${S.profile.first}`, 'ok');
    });
  };
  welcomeRenderResume = renderResume;

  const openMain = () => {
    gateForm.style.display = 'none';
    main.hidden = false;
    renderResume();
  };

  if (!gated) {
    openMain();
  } else {
    gateForm.style.display = '';
    main.hidden = true;
    gateForm.onsubmit = async e => {
      e.preventDefault();
      const entered = $('#w-code').value.trim();
      if (entered === CONFIG.JOIN_CODE) {
        if (!removed) setMsg('');
        openMain();
        return;
      }
      const invite = await validateInviteCode(entered);
      if (invite) {
        pendingInvite = invite;
        if (!removed) setMsg('');
        openMain();
      } else {
        setMsg('Wrong or already-used code — ask whoever shared the app for a new invite.');
      }
    };

    // arrived through a one-time invite link (…?join=CODE)
    const joinCode = new URLSearchParams(location.search).get('join');
    if (joinCode) {
      history.replaceState(null, '', location.pathname); // don't retry on reload
      validateInviteCode(joinCode).then(invite => {
        if (main.hidden === false) return; // already through the gate
        if (invite) {
          pendingInvite = invite;
          openMain();
        } else {
          setMsg('That invite link was already used — ask for a new one, or enter an access code.');
        }
      });
    }
  }

  const form = $('#welcome-form');
  form.onsubmit = async e => {
    e.preventDefault();
    const first = $('#w-first').value.trim();
    const last = $('#w-last').value.trim();
    const company = $('#w-company').value.trim();
    const position = $('#w-position').value.trim();
    if (!first || !last || !company || !position) { setErr('Please fill in every field.'); return; }
    const phone = normalizePhone($('#w-phone').value.trim());
    if (!phone) { setErr('Enter a valid 10-digit cell number.'); $('#w-phone').focus(); return; }
    const pin = $('#w-pin').value.trim();
    if (!/^\d{4}$/.test(pin)) { setErr('Your PIN must be exactly 4 digits.'); $('#w-pin').focus(); return; }
    await saveProfile({ first, last, company, position, phone, pin });
    if (pendingInvite) { await consumeInvite(pendingInvite); pendingInvite = null; }
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
  $('#tab-videos').style.display = canISeeVideos() ? '' : 'none';
  if (!S.owner && currentTab === 'job') showTab('map');
  if (!canISeeVideos() && currentTab === 'videos') showTab('map');
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
