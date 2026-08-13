// ── Settings tab: project name, profile, connection, owner unlock ──

import { $, $$, esc, on, toast, confirmDlg, modalForm, sha256hex, fmtTime, formatPhone, normalizePhone } from './util.js';
import { CONFIG } from './config.js';
import {
  S, projectName, setSetting, saveProfile, unlockOwner, lockOwner, activeUsers, removeUser, setUserPin,
  canIInvite, newInvite, setUserInvitePermission, setUserVideoPermission,
} from './store.js';
import { syncState, kick } from './sync.js';

export function initSettings() {
  on('sync', renderSettings);
  on('owner', renderSettings);
  on('profile', renderSettings);
  on('data:app_settings', renderSettings);
  on('data:users', renderSettings);
}

function renderCrew() {
  const users = activeUsers();
  if (!users.length) return `<div class="empty-hint">No one yet.</div>`;
  return users.map(u => {
    const me = u.id === S.profile.id;
    const tel = normalizePhone(u.phone);
    return `
      <div class="crew-row">
        <div class="crew-info">
          <div class="crew-name">${esc(u.name)}${me ? ' <span class="you-tag">you</span>' : ''}</div>
          <div class="crew-meta">${esc(u.position || '')}${u.position && u.company ? ' · ' : ''}${esc(u.company || '')}</div>
          ${tel ? `<a class="crew-phone" href="tel:${tel}">${esc(formatPhone(u.phone))}</a>` : ''}
        </div>
        <div class="crew-actions">
          ${S.owner && !me ? `
            <button class="btn small ${u.can_videos ? 'primary' : 'ghost'}" data-vidtoggle="${u.id}"
              title="Let them see inspection videos">${u.can_videos ? 'Videos ✓' : 'Videos'}</button>
            <button class="btn small ${u.can_invite ? 'primary' : 'ghost'}" data-invtoggle="${u.id}"
              title="Let them create one-time invite links">${u.can_invite ? 'Invites ✓' : 'Invites'}</button>
            ${u.pin ? `<button class="btn small ghost" data-resetpin="${u.id}" title="Clear their PIN so they can set a new one">Reset PIN</button>` : ''}
            <button class="icon-btn tiny danger-ghost" data-remove="${u.id}" title="Remove">✕</button>
          ` : ''}
        </div>
      </div>`;
  }).join('');
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
      <h4>Project</h4>
      <div class="setting-row">
        <div><div class="setting-label">Mine / project name</div>
        <div class="setting-value">${esc(projectName())} Project</div></div>
        ${S.owner ? `<button class="btn small" id="s-project">Edit</button>` : ''}
      </div>
      <div class="setting-hint">👥 Everyone sees this name.${S.owner ? ' Only you can change it.' : ' Only the owner can change it.'}</div>
    </section>

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
      <h4>Owner tools</h4>
      ${S.owner
        ? `<div class="setting-hint">🔓 Unlocked on this phone — your private <b>Job tab</b> (runs, hours, night stays) and <b>video uploading</b> are on. Just for you.</div>
           <button class="btn small ghost" id="s-lock">Lock on this phone</button>`
        : `<div class="setting-hint">🔒 The <b>Job tab</b> (billing, runs, hours) and <b>uploading videos</b> are owner-only. Enter your code to turn them on for this phone.</div>
           <button class="btn small primary" id="s-unlock">Unlock owner tools</button>`}
    </section>

    <section class="card">
      <h4>Invite someone</h4>
      ${canIInvite() ? `
        <div class="setting-hint">Each invite link works <b>once</b> — send it to one person while
        you have signal. They tap it, sign up, and the link is dead.</div>
        <button class="btn small primary" id="s-invite">✉️ ${navigator.share ? 'Share invite link' : 'Copy invite link'}</button>
      ` : `
        <div class="setting-hint">Adding someone takes a one-time invite link — ask the app owner
        (or an authorized crew member) to send one.</div>
      `}
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

  const projectBtn = $('#s-project');
  if (projectBtn) projectBtn.onclick = async () => {
    const res = await modalForm({
      title: 'Mine / project name',
      fields: [{ name: 'v', label: 'Name (e.g. Black Thunder)', value: getRaw(), required: true }],
    });
    if (res && res.v.trim()) {
      await setSetting('project_name', res.v.trim());
      toast('Project name updated for everyone', 'ok');
    }
  };
  function getRaw() {
    const v = projectName();
    return v === CONFIG.DEFAULT_PROJECT_NAME ? '' : v;
  }

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
      title: 'Unlock Job tab',
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

  const inviteBtn = $('#s-invite');
  if (inviteBtn) inviteBtn.onclick = async () => {
    inviteBtn.disabled = true;
    try {
      const inv = await newInvite();
      kick(); // push it now so the link works the moment it's sent
      const url = `${location.origin}${location.pathname}?join=${inv.code}`;
      const text = `Join ${projectName()} Project: ${url}\nOne-time invite — code ${inv.code}`;
      if (navigator.share) {
        try { await navigator.share({ title: `${projectName()} Project`, text }); }
        catch { /* user closed the share sheet */ }
      } else {
        await navigator.clipboard.writeText(text);
        toast('Invite copied — send it to one person', 'ok');
      }
    } catch {
      toast('Could not create the invite — try again', 'warn');
    } finally {
      inviteBtn.disabled = false;
    }
  };

  // owner-only: grant / revoke invite permission
  $$('[data-invtoggle]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.invtoggle);
    if (!u) return;
    await setUserInvitePermission(u.id, !u.can_invite);
    toast(u.can_invite ? `${u.name} can no longer invite` : `${u.name} can now send invite links`, 'ok');
  });

  // owner-only: grant / revoke video visibility
  $$('[data-vidtoggle]').forEach(btn => btn.onclick = async () => {
    const u = activeUsers().find(x => x.id === btn.dataset.vidtoggle);
    if (!u) return;
    await setUserVideoPermission(u.id, !u.can_videos);
    toast(u.can_videos ? `${u.name} can no longer see videos` : `${u.name} can now see inspection videos`, 'ok');
  });
}
