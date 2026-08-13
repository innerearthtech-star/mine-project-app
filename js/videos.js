// ── Video inspections tab: resumable uploads + playback ────────────
// Files go straight to Supabase storage over TUS (resumable — a signal
// drop pauses the upload instead of restarting a 10GB file). Only the
// metadata row goes through the normal offline sync.

import {
  $, $$, esc, on, toast, confirmDlg, uuid, debounce, viewPhoto, compressImage,
  fmtDate, fmtTime, fmtDateTime, toLocalInput,
} from './util.js';
import { CONFIG } from './config.js';
import { S, findRow, softDelete, activeBoreholes, activeVideos, newVideo } from './store.js';
import { isConfigured, getClient, kick } from './sync.js';

let selectedWell = null;   // {id, name} chosen in the picker
let pickedFile = null;
let pickedShots = [];      // screenshot File objects
let currentUpload = null;  // active tus.Upload
let uploading = false;     // whole-flow guard (screenshots + video)
let q = '';                // list search

export function initVideos() {
  on('data:videos', renderVideoList);
  on('data:boreholes', () => { renderWellResults(); renderVideoList(); });
  on('owner', renderVideosTab); // uploading is owner-only; re-render on unlock
  // a 10GB upload takes an hour+ — warn before the tab closes mid-flight
  window.addEventListener('beforeunload', e => {
    if (uploading || currentUpload) { e.preventDefault(); e.returnValue = ''; }
  });
  renderVideosTab();
}

// Re-stamp the date field to "now" when the tab is shown (a PWA left open
// overnight would otherwise offer yesterday's boot time as the default).
export function refreshUploadDefaults() {
  if (uploading || currentUpload) return;
  const ts = $('#v-ts');
  if (ts) ts.value = toLocalInput();
}

export function renderVideosTab() {
  const root = $('#view-videos .tab-body');
  // Uploading is owner-only. Everyone can search and watch.
  const canUpload = isConfigured() && S.owner;
  root.innerHTML = `
    ${canUpload ? `
    <section class="card" id="upload-card">
      <h4>Upload inspection</h4>
        <label class="field"><span>Borehole (add it on the map first)</span>
          <input id="v-well" type="text" placeholder="Tap to pick a well…" autocomplete="off">
          <div id="v-well-results" class="picker-results"></div>
        </label>
        <label class="field"><span>Inspection date & time</span>
          <input id="v-ts" type="datetime-local" value="${toLocalInput()}"></label>
        <label class="field"><span>Note (optional)</span>
          <input id="v-note" type="text" placeholder="e.g. camera run to 400ft"></label>
        <label class="field"><span>Video file (optional if you're only adding screenshots)</span>
          <input id="v-file" type="file" accept="video/*,.mp4,.mov,.avi,.mkv"></label>
        <label class="field"><span>Screenshots (optional — select all the images at once)</span>
          <input id="v-shots" type="file" accept="image/*" multiple></label>
        <div id="v-progress" class="upload-progress" hidden>
          <div class="upload-bar"><div class="upload-fill" id="v-fill"></div></div>
          <div class="upload-status" id="v-status"></div>
          <div class="upload-actions">
            <button class="btn small" id="v-pause">Pause</button>
            <button class="btn small danger-ghost" id="v-abort">Cancel upload</button>
          </div>
        </div>
        <button class="btn primary big" id="v-upload">Upload</button>
        <div class="setting-hint">Uploads are resumable — if Starlink hiccups it picks up where
        it left off. Keep this page open until it finishes.</div>
    </section>` : `
    <div class="setting-hint" style="margin-bottom:12px">📼 Search and watch inspection videos below.${isConfigured() ? ' Uploading is owner-only (unlock owner tools in Settings).' : ''}</div>`}

    <div class="contacts-top">
      <input id="video-search" type="search" placeholder="Search videos by well…" autocomplete="off">
    </div>
    <div id="video-list"></div>
  `;

  if (canUpload) wireUpload(root);
  $('#video-search').oninput = debounce(e => {
    q = e.target.value.trim().toLowerCase();
    renderVideoList();
  }, 120);
  renderVideoList();
}

// ── Searchable well picker ─────────────────────────────────────────
function renderWellResults() {
  const box = $('#v-well-results');
  const input = $('#v-well');
  if (!box || !input) return;
  // only pop the dropdown while the user is actually in the field —
  // background borehole syncs shouldn't open it on their own
  if (document.activeElement !== input) return;
  const term = input.value.trim().toLowerCase();
  // Just re-focused a field that already holds the chosen well → show the
  // full list again so they can switch; typing (which clears selectedWell)
  // then filters live.
  const showAll = selectedWell && input.value === selectedWell.name;
  const wells = activeBoreholes().filter(b => showAll || !term || b.name.toLowerCase().includes(term));
  if (!wells.length) {
    box.innerHTML = `<div class="empty-hint">${activeBoreholes().length
      ? 'No well matches' : 'No wells yet — drop a pin on the map first'}</div>`;
    return;
  }
  box.innerHTML = wells.slice(0, 8).map(b =>
    `<button class="picker-row" data-id="${b.id}">${esc(b.name)}</button>`).join('');
  $$('.picker-row', box).forEach(el => el.onclick = () => {
    const b = findRow('boreholes', el.dataset.id);
    selectedWell = { id: b.id, name: b.name };
    input.value = b.name;
    box.innerHTML = '';
    input.blur(); // picking a well drops the keyboard too
  });
}

function wireUpload(root) {
  const wellInput = $('#v-well', root);
  wellInput.oninput = () => { selectedWell = null; renderWellResults(); };
  wellInput.onfocus = renderWellResults;
  // dismissing the keyboard (or tapping elsewhere) closes the well list —
  // the delay lets a tap on one of the options land first
  wellInput.onblur = () => setTimeout(() => {
    if (document.activeElement !== wellInput) {
      const box = $('#v-well-results');
      if (box) box.innerHTML = '';
    }
  }, 200);

  $('#v-file', root).onchange = e => { pickedFile = e.target.files[0] || null; };
  $('#v-shots', root).onchange = e => { pickedShots = [...e.target.files]; };

  $('#v-upload', root).onclick = () => {
    if (uploading || currentUpload) { toast('An upload is already running', 'warn'); return; }
    if (!selectedWell) { toast('Pick the borehole first', 'warn'); return; }
    const tsVal = $('#v-ts', root).value;
    if (!tsVal || isNaN(new Date(tsVal))) { toast('Enter a valid date & time', 'warn'); return; }
    if (!pickedFile && !pickedShots.length) { toast('Choose a video and/or screenshots', 'warn'); return; }
    startUpload({
      well: selectedWell,
      ts: new Date(tsVal).toISOString(),
      note: $('#v-note', root).value.trim(),
      file: pickedFile,
      shots: pickedShots,
    });
  };
}

// ── Upload flow: screenshots first (quick), then the video (TUS) ───
async function startUpload({ well, ts, note, file, shots }) {
  if (file && !window.tus) { toast('Upload library failed to load — refresh the page', 'warn'); return; }
  const progress = $('#v-progress'), fill = $('#v-fill'), status = $('#v-status');
  const uploadBtn = $('#v-upload');
  progress.hidden = false;
  uploadBtn.disabled = true;
  uploading = true;

  const finishUI = () => {
    uploading = false;
    currentUpload = null;
    progress.hidden = true;
    fill.style.width = '0%';
    uploadBtn.disabled = false;
  };
  const doneAll = async (videoPath, videoSize, shotPaths) => {
    await newVideo(well.id, ts, note, videoPath, videoSize, shotPaths);
    kick();
    finishUI();
    const f = $('#v-file'); if (f) f.value = '';
    const sh = $('#v-shots'); if (sh) sh.value = '';
    const t = $('#v-ts'); if (t) t.value = toLocalInput();
    const n = $('#v-note'); if (n) n.value = '';
    const w = $('#v-well'); if (w) w.value = '';
    pickedFile = null;
    pickedShots = [];
    selectedWell = null; // don't carry the well/note onto the next inspection
    toast(`Inspection saved to ${well.name}`, 'ok');
  };

  const actions = $('.upload-actions', progress);
  actions.style.display = '';           // reset after any earlier failure
  const pauseBtn = $('#v-pause');
  pauseBtn.textContent = 'Pause';

  // 1) screenshots — standard uploads into the photos bucket (small files,
  //    and the service worker then caches them for offline viewing)
  const shotPaths = [];
  const groupId = uuid();
  for (let i = 0; i < shots.length; i++) {
    status.textContent = `Uploading screenshot ${i + 1} of ${shots.length}…`;
    fill.style.width = `${((i / Math.max(1, shots.length)) * 100).toFixed(0)}%`;
    let blob = shots[i];
    try { blob = await compressImage(shots[i], 1920, 0.85); } catch { /* upload as-is */ }
    const p = `screens/${groupId}/${uuid()}.jpg`;
    const { error } = await getClient().storage.from('photos')
      .upload(p, blob, { contentType: 'image/jpeg', upsert: true });
    if (error) {
      finishUI();
      toast(`Screenshot upload failed: ${error.message}`, 'warn');
      return;
    }
    shotPaths.push(p);
  }
  fill.style.width = '0%';

  // 2) no video? save the inspection now
  if (!file) { await doneAll(null, 0, shotPaths); return; }

  // 3) the video — resumable TUS upload
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0].toLowerCase();
  const MIME = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  };
  // `let` — resuming a previous attempt adopts the path the file is
  // actually landing at, so the saved row always points at the real object
  let path = `${well.id}/${uuid()}${ext}`;
  let paused = false;

  const upload = new tus.Upload(file, {
    endpoint: `${CONFIG.SUPABASE_URL}/storage/v1/upload/resumable`,
    retryDelays: [0, 3000, 5000, 10000, 20000, 60000],
    headers: {
      authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      'x-upsert': 'true',
    },
    uploadDataDuringCreation: true,
    removeFingerprintOnSuccess: true,
    chunkSize: 6 * 1024 * 1024, // Supabase requires exactly 6MB chunks
    metadata: {
      bucketName: 'videos',
      objectName: path,
      contentType: file.type || MIME[ext] || 'application/octet-stream',
      cacheControl: '3600',
    },
    onError(err) {
      uploading = false;
      currentUpload = null;
      uploadBtn.disabled = false;
      actions.style.display = 'none'; // pause/cancel are dead once it failed
      status.textContent = `Upload failed: ${err.message || err}. Your progress is saved — hit Upload again to resume.`;
      toast('Upload failed — try again to resume', 'warn');
    },
    onProgress(sent, total) {
      const pct = total ? (sent / total) * 100 : 0;
      fill.style.width = `${pct.toFixed(1)}%`;
      status.textContent = `${fmtBytes(sent)} of ${fmtBytes(total)} — ${pct.toFixed(1)}%${paused ? ' (paused)' : ''}`;
    },
    async onSuccess() {
      await doneAll(path, file.size, shotPaths);
    },
  });

  currentUpload = upload;
  status.textContent = 'Starting…';

  pauseBtn.onclick = () => {
    if (!currentUpload) return;
    if (paused) {
      paused = false;
      pauseBtn.textContent = 'Pause';
      currentUpload.start();
    } else {
      paused = true;
      pauseBtn.textContent = 'Resume';
      currentUpload.abort(); // pauses; fingerprint keeps resume state
      status.textContent += ' (paused)';
    }
  };
  $('#v-abort').onclick = async () => {
    if (!currentUpload) return;
    if (await confirmDlg('Cancel this upload?', { okText: 'Cancel upload', danger: true })) {
      const u = currentUpload;
      finishUI();
      try {
        const r = u.abort(true); // best effort — offline is fine
        if (r && r.catch) r.catch(() => {});
      } catch { /* already stopped */ }
      try {
        // drop the resume fingerprint so a cancelled upload can't resurrect
        (await u.findPreviousUploads()).forEach(p =>
          p.urlStorageKey && localStorage.removeItem(p.urlStorageKey));
      } catch { /* ignore */ }
    }
  };

  // Resume a previous attempt of this same file if one exists for THIS
  // well — and adopt the path it's already landing at, so the metadata
  // row matches the real object even across a page reload.
  upload.findPreviousUploads().then(prev => {
    const match = prev.find(p =>
      p.metadata && p.metadata.objectName && p.metadata.objectName.startsWith(`${well.id}/`));
    if (match) {
      path = match.metadata.objectName;
      upload.options.metadata.objectName = path;
      upload.resumeFromPreviousUpload(match);
    }
    upload.start();
  });
}

// ── Video list (tab) ───────────────────────────────────────────────
export function renderVideoList() {
  const wrap = $('#video-list');
  if (!wrap) return;
  // never rebuild the list out from under someone mid-watch — the list
  // catches up the moment they close the player/screenshots
  if ($('.video-player:not([hidden]), .shot-grid:not([hidden])', wrap)) return;
  const wellName = id => { const b = findRow('boreholes', id); return b ? b.name : 'Unknown well'; };
  const vids = activeVideos().filter(v =>
    !q || wellName(v.borehole_id).toLowerCase().includes(q) || (v.note || '').toLowerCase().includes(q));
  if (!vids.length) {
    wrap.innerHTML = `<div class="empty-hint">${q ? 'No videos match.' :
      'No inspection videos yet. They’ll show up here and on each well’s pin.'}</div>`;
    return;
  }
  wrap.innerHTML = vids.map(v => videoCard(v, wellName(v.borehole_id))).join('');
  wireVideoCards(wrap);
}

export function videoCard(v, wellNameStr) {
  const shots = v.screenshots || [];
  return `
    <div class="video-card" data-vid="${v.id}">
      <div class="video-info">
        <div class="video-well">${esc(wellNameStr)}</div>
        <div class="video-meta">${fmtDate(v.ts)} · ${fmtTime(v.ts)}${v.size ? ` · ${fmtBytes(v.size)}` : ''}</div>
        ${v.note ? `<div class="video-note">${esc(v.note)}</div>` : ''}
        <div class="video-meta muted">Uploaded by ${esc(v.uploaded_by || '?')}</div>
      </div>
      <div class="video-actions">
        ${v.path ? (isPlayable(v.path)
          ? `<button class="btn small primary" data-play="${v.id}">▶ Play</button>`
          : `<a class="btn small primary" href="${esc(videoURL(v.path))}?download" target="_blank"
               rel="noopener" title="This format plays after downloading">⬇ Download video</a>`) : ''}
        ${shots.length ? `<button class="btn small" data-shots="${v.id}">🖼 Screenshots (${shots.length})</button>` : ''}
        ${S.owner ? `<button class="icon-btn tiny" data-vdel="${v.id}" title="Delete">✕</button>` : ''}
      </div>
      <div class="video-player" data-player="${v.id}" hidden></div>
      <div class="shot-grid" data-shotgrid="${v.id}" hidden></div>
    </div>`;
}

const isPlayable = p => /\.(mp4|m4v|mov|webm)$/i.test(p || '');
const videoURL = p => `${CONFIG.SUPABASE_URL}/storage/v1/object/public/videos/${p}`;

export function wireVideoCards(scope, onDelete) {
  const collapse = () => {
    $$('.video-player, .shot-grid', scope).forEach(p => { p.hidden = true; p.innerHTML = ''; });
    $$('[data-play]', scope).forEach(b => b.textContent = '▶ Play');
    $$('[data-shots]', scope).forEach(b => {
      const v = findRow('videos', b.dataset.shots);
      b.textContent = `🖼 Screenshots (${(v?.screenshots || []).length})`;
    });
  };

  // when a viewer closes a player, deliver any list updates that were
  // held back while they were watching
  const catchUp = holder => {
    const wrap = $('#video-list');
    if (wrap && wrap.contains(holder)) renderVideoList();
  };

  $$('[data-play]', scope).forEach(btn => btn.onclick = () => {
    const v = findRow('videos', btn.dataset.play);
    if (!v || !v.path) return;
    const holder = btn.closest('.video-card').querySelector('.video-player');
    const wasOpen = !holder.hidden;
    collapse();
    if (wasOpen) { catchUp(holder); return; }
    const url = videoURL(v.path);
    holder.innerHTML = `<video controls preload="metadata" playsinline src="${esc(url)}"></video>
      <a class="btn small ghost" href="${esc(url)}?download" target="_blank" rel="noopener">Download</a>`;
    holder.hidden = false;
    btn.textContent = '✕ Close';
  });

  $$('[data-shots]', scope).forEach(btn => btn.onclick = () => {
    const v = findRow('videos', btn.dataset.shots);
    const shots = v?.screenshots || [];
    if (!shots.length) return;
    const holder = btn.closest('.video-card').querySelector('.shot-grid');
    const wasOpen = !holder.hidden;
    collapse();
    if (wasOpen) { catchUp(holder); return; }
    holder.innerHTML = shots.map(p => {
      const url = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/photos/${p}`;
      return `<img src="${esc(url)}" loading="lazy" crossorigin="anonymous"
                   onerror="this.style.display='none'">`;
    }).join('');
    $$('img', holder).forEach(im => im.onclick = () => viewPhoto(im.src));
    holder.hidden = false;
    btn.textContent = '✕ Close screenshots';
  });

  $$('[data-vdel]', scope).forEach(btn => btn.onclick = async () => {
    const v = findRow('videos', btn.dataset.vdel);
    if (!v) return;
    if (await confirmDlg('Delete this inspection (video + screenshots) for everyone?', { okText: 'Delete', danger: true })) {
      await softDelete('videos', v);
      // best-effort: also remove the actual files so a deleted 10GB video
      // stops counting against storage (paths are per-upload UUIDs)
      try {
        const c = isConfigured() && getClient();
        if (c) {
          if (v.path) await c.storage.from('videos').remove([v.path]);
          if (v.screenshots?.length) await c.storage.from('photos').remove(v.screenshots);
        }
      } catch { /* offline — the metadata delete still hides it everywhere */ }
      toast('Inspection deleted', 'ok');
      if (onDelete) onDelete();
    }
  });
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 2 ? 2 : i ? 1 : 0)} ${u[i]}`;
}
