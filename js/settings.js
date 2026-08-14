// ── Settings tab: project name, profile, connection, owner unlock ──

import { $, $$, esc, on, toast, confirmDlg, modalForm, sha256hex, fmtTime, formatPhone, normalizePhone } from './util.js';
import { CONFIG } from './config.js';
import {
  S, projectName, saveProfile, unlockOwner, lockOwner, activeUsers, removeUser, setUserPin,
  setUserVideoPermission, canIGrant, pendingUsers, setUserApproved, setUserGrantPermission,
  setUserJobPermission,
} from './store.js';
import { syncState, kick } from './sync.js';

export function initSettings() {
  on('sync', renderSettings);
  on('owner', renderSettings);
  on('profile', renderSettings);
  on('data:app_settings', renderSettings);
  on('data:users', renderSettings);
}

function crewRow(u) {
  const me = u.id === S.profile.id;
  const tel = normalizePhone(u.phone);
  const granter = canIGrant();
  return `
    <div class="crew-row ${u.approved ? '' : 'crew-pending'}">
      <div class="crew-head">
        <div class="crew-info">
          <div class="crew-name">${esc(u.name)}${me ? ' <span class="you-tag">you</span>' : ''}
            ${!u.approved ? ' <span class="wait-tag">waiting</span>' : ''}</div>
          <div class="crew-meta">${esc(u.position || '')}${u.position && u.company ? ' · ' : ''}${esc(u.company || '')}</div>
          ${tel ? `<a class="crew-phone" href="tel:${tel}">${esc(formatPhone(u.phone))}</a>` : ''}
        </div>
        ${S.owner && !me ? `<button class="icon-btn tiny danger-ghost" data-remove="${u.id}" title="Remove">✕</button>` : ''}
      </div>
      ${granter && !me ? `
      <div class="crew-perms">
        <button class="btn small perm ${u.approved ? 'perm-on' : ''}" data-approve="${u.id}"
          title="Base access: map, wells, notes, contacts">Access</button>
        <button class="btn small perm ${u.can_videos ? 'perm-on' : ''}" data-vidtoggle="${u.id}"
          title="Let them see inspection videos">Videos</button>
        <button class="btn small perm ${u.can_job ? 'perm-on' : ''}" data-jobtoggle="${u.id}"
          title="Give them their own private Job tab (their runs/hours only)">Job</button>
        ${S.owner ? `<button class="btn small perm ${u.can_grant ? 'perm-on' : ''}" data-granttoggle="${u.id}"
          title="Let them approve people and grant access/videos">Can grant</button>` : ''}
        ${S.owner && u.pin ? `<button class="btn small ghost" data-resetpin="${u.id}" title="Clear their PIN so they can set a new one">Reset PIN</button>` : ''}
      </div>` : ''}
    </div>`;
}

function renderCrew() {
  const users = activeUsers();
  if (!users.length) return `<div class="empty-hint">No one yet.</div>`;
  // people waiting for access float to the top for granters
  const pending = canIGrant() ? users.filter(u => !u.approved && u.id !== S.profile.id) : [];
  const rest = users.filter(u => !pending.includes(u));
  return [...pending, ...rest].map(crewRow).join('');
}

export function renderSettings() {
  const root = $('#view-settings .tab-body');
  if (!root || !S.profile) return;

  const st = syncState;
  const conn = !st.configured
    ? `<span class="dot dot-gray"></span> Local only — not connected yet`
    : !st.online
      ? `<span class="dot dot-red"></span> Offline — ${st.pending} change${st.pending === 1 ? '' : 's'} waiting to sync`
      : st.pending
        ? `<span class="dot dot-amber"></span> Syncing — ${st.pending} pending`
        : `<span class="dot dot-green"></span> Connected & synced${st.lastSync ? ` · ${fmtTime(st.lastSync)}` : ''}`;

  root.innerHTML = `
    <section class="card">
      <h4>You</h4>
      <div class="setting-row">
        <div>
          <div class="setting-value">${esc(S.profile.name)}</div>
          <div class="setting-label">${esc(S.profile.position || '')}${S.profile.position && S.profile.company ? ' · ' : ''}${esc(S.profile.company || '')}</div>
          <div class="setting-label">${esc(formatPhone(S.profile.phone))}</div>
        </div>
        <button class="btn small" id="s-name">Edit</button>
      </div>
      <div class="setting-hint">Your name shows on every pin and note you add.</div>
    </section>

    <section class="card">
      <div class="card-head"><h4>Crew on this app</h4><span class="badge">${activeUsers().length}</span></div>
      <div class="setting-hint">Everyone who's signed in${S.owner ? ' — only you can remove someone.' : '.'}</div>
      <div id="crew-list">${renderCrew()}</div>
    </section>

    <section class="card">
      <h4>Connection</h4>
      <div class="conn-status">${conn}</div>
      ${st.dropped ? `<div class="conn-error">⚠ ${st.dropped} change${st.dropped === 1 ? '' : 's'} could not sync and stayed only on this phone.</div>` : ''}
      ${st.error ? `<div class="conn-error">Last sync problem: ${esc(st.error)}</div>` : ''}
      ${st.configured ? `<button class="btn small" id="s-sync">Sync now</button>`
        : `<div class="setting-hint">Supabase isn't configured yet — pins and notes stay on this phone. See SETUP.md.</div>`}
    </section>

    <section class="card">
      <h4>Admin tools</h4>
      ${S.owner
        ? `<div class="setting-hint">🔓 Unlocked on this phone — your private <b>Job tab</b> (runs, hours, night stays) and <b>video uploading</b> are on. Just for you.</div>
           <button class="btn small ghost" id="s-lock">Lock on this phone</button>`
        : `<div class="setting-hint">🔒 The <b>Job tab</b> (billing, runs, hours) and <b>uploading videos</b> are admin-only. Enter your code to turn them on for this phone.</div>
           <button class="btn small primary" id="s-unlock">Unlock admin tools</button>`}
    </section>

    <section class="card">
      <h4>Add someone</h4>
      <div class="setting-hint">Send them the app link — they sign up and land in a waiting room
      with <b>no access</b> until ${canIGrant() ? 'you approve them here (they float to the top of the crew list)' : 'someone with granting power approves them'}.</div>
      <button class="btn small primary" id="s-share">${navigator.share ? '✉️ Share the app link' : '📋 Copy the app link'}</button>
      <div class="setting-hint" style="margin-top:10px">
        📱 <b>Install on your phone:</b> iPhone — Share button → “Add to Home Screen”.
        Android — browser menu → “Install app”.
      </div>
    </section>

    <section class="card about">
      <div class="about-logo">⛏</div>
      <div><b>${esc(projectName())} Project</b> v${CONFIG.APP_VERSION}<br>
      <span class="muted">Built by Inner Earth Tech 😏</span></div>
    </section>
  `;

  $('#s-name').onclick = async () => {
    const res = await modalForm({
      title: 'Your details',
      fields: [
        { name: 'first', label: 'First name', value: S.profile.first, required: true },
        { name: 'last', label: 'Last name', value: S.profile.last, required: true },
        { name: 'company', label: 'Company', value: S.profile.company, required: true },
        { name: 'position', label: 'Position', value: S.profile.position, required: true },
        { name: 'phone', label: 'Cell number', type: 'tel', value: formatPhone(S.profile.phone), required: true },
        { name: 'pin', label: 'New 4-digit PIN (blank = keep current)', type: 'password', inputmode: 'numeric' },
      ],
    });
    if (!res) return;
    if (!res.first.trim() || !res.last.trim() || !res.company.trim() || !res.position.trim()) {
      toast('Please fill in every field', 'warn'); return;
    }
    const phone = normalizePhone(res.phone);
    if (!phone) { toast('Enter a valid 10-digit cell number', 'warn'); return; }
    const pin = (res.pin || '').trim();
    if (pin && !/^\d{4}$/.test(pin)) { toast('PIN must be exactly 4 digits', 'warn'); return; }
    await saveProfile({ first: res.first, last: res.last, company: res.company, position: res.position, phone, pin: pin || undefined });
    toast('Your details updated', 'ok');
  };

  // owner-only: clear someone's PIN so they can set a fresh one
  $$('[data-resetpin]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.resetpin);
    if (!u) return;
    if (await confirmDlg(`Reset ${u.name}'s PIN? They'll set a new one next time they sign in.`, { okText: 'Reset PIN' })) {
      await setUserPin(u.id, null);
      toast(`${u.name}'s PIN was reset`, 'ok');
    }
  });

  // owner-only: remove someone from the roster
  $$('[data-remove]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.remove);
    if (!u) return;
    if (await confirmDlg(`Remove ${u.name} from the app?`, { okText: 'Remove', danger: true,
      title: 'Remove crew member' })) {
      await removeUser(u.id);
      toast(`${u.name} removed`, 'ok');
    }
  });

  const syncBtn = $('#s-sync');
  if (syncBtn) syncBtn.onclick = () => { kick(); toast('Syncing…', 'info'); };

  const unlockBtn = $('#s-unlock');
  if (unlockBtn) unlockBtn.onclick = async () => {
    const res = await modalForm({
      title: 'Unlock admin tools',
      fields: [{ name: 'code', label: 'Owner code', type: 'password', required: true }],
      okText: 'Unlock',
    });
    if (!res) return;
    if (res.code === CONFIG.OWNER_CODE) {
      await unlockOwner(await sha256hex(res.code));
      toast('Job tab unlocked', 'ok');
    } else {
      toast('Wrong code', 'warn');
    }
  };

  const lockBtn = $('#s-lock');
  if (lockBtn) lockBtn.onclick = async () => {
    if (await confirmDlg('Hide the Job tab on this phone? Your data stays saved — unlock again anytime.')) {
      await lockOwner();
    }
  };

  const shareBtn = $('#s-share');
  if (shareBtn) shareBtn.onclick = async () => {
    const url = location.origin + location.pathname;
    const text = `Join ${projectName()} Project: ${url}\nSign up and I'll approve your access.`;
    if (navigator.share) {
      try { await navigator.share({ title: `${projectName()} Project`, text }); }
      catch { /* user closed the share sheet */ }
    } else {
      try { await navigator.clipboard.writeText(text); toast('Link copied', 'ok'); }
      catch { toast('Could not copy the link', 'warn'); }
    }
  };

  // granters: approve / revoke base access
  $$('[data-approve]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.approve);
    if (!u) return;
    await setUserApproved(u.id, !u.approved);
    toast(u.approved ? `${u.name}'s access was turned off` : `${u.name} is in — access granted`, 'ok');
  });

  // granters: grant / revoke video visibility
  $$('[data-vidtoggle]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.vidtoggle);
    if (!u) return;
    await setUserVideoPermission(u.id, !u.can_videos);
    toast(u.can_videos ? `${u.name} can no longer see videos` : `${u.name} can now see inspection videos`, 'ok');
  });

  // granters: give someone their own private Job tab
  $$('[data-jobtoggle]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.jobtoggle);
    if (!u) return;
    await setUserJobPermission(u.id, !u.can_job);
    toast(u.can_job ? `${u.name}'s Job tab was turned off` : `${u.name} now has their own Job tab`, 'ok');
  });

  // owner only: deputize someone to approve/grant for others
  $$('[data-granttoggle]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.granttoggle);
    if (!u) return;
    await setUserGrantPermission(u.id, !u.can_grant);
    toast(u.can_grant ? `${u.name} can no longer grant access` : `${u.name} can now approve people & grant access`, 'ok');
  });
}
