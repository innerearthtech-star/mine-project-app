// ── Settings tab: project name, profile, connection, owner unlock ──

import { $, esc, on, toast, confirmDlg, modalForm, sha256hex, fmtTime } from './util.js';
import { CONFIG } from './config.js';
import { S, projectName, setSetting, setProfile, unlockOwner, lockOwner } from './store.js';
import { syncState, kick } from './sync.js';

export function initSettings() {
  on('sync', renderSettings);
  on('owner', renderSettings);
  on('profile', renderSettings);
  on('data:app_settings', renderSettings);
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
        <button class="btn small" id="s-project">Edit</button>
      </div>
      <div class="setting-hint">Everyone sees this name — set it once you know the mine.</div>
    </section>

    <section class="card">
      <h4>You</h4>
      <div class="setting-row">
        <div><div class="setting-label">Your name (shown on pins & notes)</div>
        <div class="setting-value">${esc(S.profile.name)}</div></div>
        <button class="btn small" id="s-name">Edit</button>
      </div>
    </section>

    <section class="card">
      <h4>Connection</h4>
      <div class="conn-status">${conn}</div>
      ${st.error ? `<div class="conn-error">Last sync problem: ${esc(st.error)}</div>` : ''}
      ${st.configured ? `<button class="btn small" id="s-sync">Sync now</button>`
        : `<div class="setting-hint">Supabase isn't configured yet — pins and notes stay on this phone. See SETUP.md.</div>`}
    </section>

    <section class="card">
      <h4>My Job tab</h4>
      ${S.owner
        ? `<div class="setting-hint">Unlocked on this phone — runs, hours and night stays are yours only.</div>
           <button class="btn small ghost" id="s-lock">Hide Job tab on this phone</button>`
        : `<div class="setting-hint">The Job tab (billing, runs, hours) is private. Enter the owner code to show it on this phone.</div>
           <button class="btn small primary" id="s-unlock">Unlock Job tab</button>`}
    </section>

    <section class="card">
      <h4>Share this app</h4>
      <div class="setting-hint">Send anyone this link — they type their name and they're in:</div>
      <div class="share-url mono" id="s-url">${esc(location.origin + location.pathname)}</div>
      <button class="btn small" id="s-copy">Copy link</button>
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

  $('#s-project').onclick = async () => {
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
      title: 'Your name',
      fields: [{ name: 'v', label: 'Name', value: S.profile.name, required: true }],
    });
    if (res && res.v.trim()) { await setProfile(res.v.trim()); toast('Name updated', 'ok'); }
  };

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

  $('#s-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      toast('Link copied', 'ok');
    } catch { toast('Could not copy — long-press the link instead', 'warn'); }
  };
}
