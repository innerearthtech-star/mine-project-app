// ── Boot, welcome screen, waiting room, tab navigation ─────────────

import { $, $$, esc, on, toast, normalizePhone, closeSheet, closeModal, modalForm, debounce } from './util.js';
import { DB } from './db.js';
import {
  S, loadAll, saveProfile, projectName, iAmRemoved, activeUsers, resumeAs,
  checkUserPin, setUserPin, canISeeVideos, amIApproved, canIGrant, pendingUsers, canUseJob,
} from './store.js';
import { initSync, syncState, kick } from './sync.js';
import { initMap, refreshMapSize } from './map.js';
import { initJob, renderJob } from './job.js';
import { initContacts, renderContacts } from './contacts.js';
import { initSettings, renderSettings } from './settings.js';
import { initVideos, renderVideoList, refreshUploadDefaults } from './videos.js';

let currentTab = 'map';

// A crash inside a button handler must never look like "nothing happened" —
// surface it so the user knows to try again (and we can see it in feedback).
window.addEventListener('unhandledrejection', e => {
  console.error('unhandled', e.reason);
  try { toast('Something went wrong — try that again', 'warn'); } catch { /* very early */ }
});
window.addEventListener('error', e => {
  console.error('error', e.error || e.message);
  try { toast('Something went wrong — try that again', 'warn'); } catch { /* very early */ }
});

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
  on('data:users', () => {
    // removed by the owner → back to sign-in
    if (S.profile && !S.owner && iAmRemoved() && $('#app').classList.contains('show')) {
      $('#app').classList.remove('show');
      showWelcome({ removed: true });
      return;
    }
    // waiting room unlocks itself the moment approval syncs in
    if ($('#waiting').classList.contains('show') && amIApproved()) {
      $('#waiting').classList.remove('show');
      startApp();
      toast("You're in — access granted 🎉", 'ok');
      kick(); // now pull everything, not just the roster
      return;
    }
    if ($('#welcome').classList.contains('show') && welcomeRenderResume) welcomeRenderResume();
    // granted/revoked permissions (videos tab, pending badge) arrive via roster
    if ($('#app').classList.contains('show')) updateTabs();
  });

  // need sign-up if: never registered, missing the newer fields, or removed
  const incomplete = S.profile && (!S.profile.first || !S.profile.phone);
  if (!S.profile || incomplete || (iAmRemoved() && !S.owner)) {
    showWelcome({ removed: Boolean(S.profile && iAmRemoved()) });
  } else if (!amIApproved()) {
    showWaiting();
  } else {
    startApp();
  }
}

let welcomeRenderResume = null; // lets the data:users handler refresh matches

function showWelcome({ removed = false } = {}) {
  // tear down any open well sheet / dialog before returning to sign-in
  closeSheet();
  closeModal();
  $('#waiting').classList.remove('show');
  const wrap = $('#welcome');
  wrap.classList.add('show');
  $('#welcome-title').textContent = `${projectName()} Project`;

  const msg = $('#welcome-msg');
  const setMsg = m => { if (m) { msg.hidden = false; msg.textContent = m; } else { msg.hidden = true; } };
  setMsg(removed ? 'The site owner removed your access. Sign back in to rejoin.' : '');

  // iOS: keep whichever field is being typed in visible above the keyboard
  if (!wrap._kbWired) {
    wrap._kbWired = true;
    wrap.addEventListener('focusin', e => {
      wrap.classList.add('kb');
      setTimeout(() => { try { e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { } }, 300);
    });
    wrap.addEventListener('focusout', () => setTimeout(() => {
      if (!wrap.contains(document.activeElement) || document.activeElement === document.body) {
        wrap.classList.remove('kb');
      }
    }, 120));
  }

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

  // route after a successful sign-in / sign-up
  const routeIn = (welcomeText) => {
    wrap.classList.remove('show');
    if (amIApproved()) {
      startApp();
      toast(welcomeText, 'ok');
    } else {
      showWaiting();
    }
  };

  // "Find your name" — no names shown until they start typing, then tap
  // your match and prove it with your PIN
  const findInput = $('#w-find');
  const renderResume = () => {
    const box = $('#welcome-resume');
    if (!box) return;
    const q = (findInput ? findInput.value : '').trim().toLowerCase();
    if (q.length < 2) { box.innerHTML = ''; return; }
    const matches = activeUsers().filter(u => u.name.toLowerCase().includes(q)).slice(0, 6);
    if (!matches.length) {
      box.innerHTML = `<div class="resume-none">No match — check the spelling, or sign up below.</div>`;
      return;
    }
    box.innerHTML = `<div class="resume-list">
      ${matches.map(u => `<button class="resume-row" data-uid="${esc(u.id)}">
        <span class="resume-name">${esc(u.name)}</span>
        <span class="resume-co">${esc(u.company || '')}</span></button>`).join('')}
    </div>`;
    $$('.resume-row', box).forEach(btn => btn.onclick = async () => {
      const u = activeUsers().find(x => x.id === btn.dataset.uid);
      if (!u) return;
      if (u.pin) {
        const res = await modalForm({
          title: `Hi ${u.first} — enter your PIN`,
          fields: [{ name: 'pin', label: '4-digit PIN', type: 'password', inputmode: 'numeric', required: true }],
          okText: 'Sign in',
        });
        if (!res) return;
        if (!await checkUserPin(u, (res.pin || '').trim())) { toast('Wrong PIN', 'warn'); return; }
        await resumeAs(u.id);
      } else {
        // account made before PINs existed — set one now
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
      routeIn(`Welcome back, ${S.profile.first}`);
    });
  };
  welcomeRenderResume = renderResume;
  if (findInput) {
    findInput.oninput = debounce(renderResume, 120);
    renderResume();
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
    kick(); // push the new account up right away
    routeIn(`Welcome, ${first} — pins you add show your name`);
  };
}

// Signed up but not approved yet: friendly holding screen, no data on
// the phone. Unlocks live via the data:users watcher above.
function showWaiting() {
  closeSheet();
  closeModal();
  $('#welcome').classList.remove('show');
  $('#app').classList.remove('show');
  const w = $('#waiting');
  w.classList.add('show');
  $('#waiting-name').textContent = S.profile ? `Signed in as ${S.profile.name}` : '';
  $('#waiting-check').onclick = () => { kick(); toast('Checking…', 'info'); };
  $('#waiting-switch').onclick = async () => {
    await DB.kvSet('profile', null);
    S.profile = null;
    w.classList.remove('show');
    showWelcome();
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
  if (canUseJob()) renderJob();
  notifyNewJoins();
}

// Tell people with granting power how many joined since their last visit
async function notifyNewJoins() {
  if (!canIGrant()) return;
  const seen = await DB.kvGet('rosterSeenAt');
  if (seen) {
    const fresh = S.users.filter(u =>
      !u.deleted && u.id !== S.profile.id && String(u.created_at || '') > String(seen)).length;
    const waiting = pendingUsers().length;
    if (fresh) {
      toast(`${fresh} new ${fresh === 1 ? 'person' : 'people'} joined — grant access in Settings`, 'ok');
    } else if (waiting) {
      toast(`${waiting} ${waiting === 1 ? 'person is' : 'people are'} waiting for access`, 'warn');
    }
  }
  await DB.kvSet('rosterSeenAt', new Date().toISOString());
}

function renderHeader() {
  $('#header-title').textContent = `${projectName()} Project`;
  const st = syncState;
  const dot = $('#sync-dot');
  dot.className = 'dot ' + (!st.configured ? 'dot-gray' : !st.online ? 'dot-red' : st.pending ? 'dot-amber' : 'dot-green');
  dot.title = !st.configured ? 'Local only' : !st.online ? 'Offline' : st.pending ? `${st.pending} pending` : 'Synced';
}

function updateTabs() {
  $('#tab-job').style.display = canUseJob() ? '' : 'none';
  $('#tab-videos').style.display = canISeeVideos() ? '' : 'none';
  if (!canUseJob() && currentTab === 'job') showTab('map');
  if (!canISeeVideos() && currentTab === 'videos') showTab('map');
  if (canUseJob()) renderJob();
  // red dot on Settings for people who can grant access, while anyone waits
  const dotEl = $('#settings-dot');
  if (dotEl) dotEl.hidden = !(canIGrant() && pendingUsers().length > 0);
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
