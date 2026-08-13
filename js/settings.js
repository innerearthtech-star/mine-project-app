// ── Settings tab: project name, profile, connection, owner unlock ──

import { $, $$, esc, on, toast, confirmDlg, modalForm, sha256hex, fmtTime, formatPhone, normalizePhone } from './util.js';
import { CONFIG } from './config.js';
import {
  S, projectName, setSetting, saveProfile, unlockOwner, lockOwner, activeUsers, removeUser,
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
        ${S.owner && !me ? `<button class="icon-btn tiny danger-ghost" data-remove="${u.id}" title="Remove">✕</button>` : ''}
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
        <button class="btn small" id="s-project">Edit</button>
      </div>
      <div class="setting-hint">Everyone sees this name — set it once you know the mine.</div>
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
      <h4>My Job tab</h4>
      ${S.owner
        ? `<div class="setting-hint">Unlocked on this phone — runs, hours and night stays are yours only.</div>
           <button class="btn small ghost" id="s-lock">Hide Job tab on this phone</button>`
        : `<div class="setting-hint">The Job tab (billing, runs, hours) is private. Enter the owner code to show it on this phone.</div>
           <button class="btn small primary" id="s-unlock">Unlock Job tab</button>`}
    </section>

    <section class="card">
      <h4>Share this app</h4>
      <div class="setting-hint">Send anyone this link — they enter their details and they're in:</div>
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
      title: 'Your details',
      fields: [
        { name: 'first', label: 'First name', value: S.profile.first, required: true },
        { name: 'last', label: 'Last name', value: S.profile.last, required: true },
        { name: 'company', label: 'Company', value: S.profile.company, required: true },
        { name: 'position', label: 'Position', value: S.profile.position, required: true },
        { name: 'phone', label: 'Cell number', type: 'tel', value: formatPhone(S.profile.phone), required: true },
      ],
    });
    if (!res) return;
    if (!res.first.trim() || !res.last.trim() || !res.company.trim() || !res.position.trim()) {
      toast('Please fill in every field', 'warn'); return;
    }
    const phone = normalizePhone(res.phone);
    if (!phone) { toast('Enter a valid 10-digit cell number', 'warn'); return; }
    await saveProfile({ first: res.first, last: res.last, company: res.company, position: res.position, phone });
    toast('Your details updated', 'ok');
  };

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

  $('#s-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      toast('Link copied', 'ok');
    } catch { toast('Could not copy — long-press the link instead', 'warn'); }
  };
}
