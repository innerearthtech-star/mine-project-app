// ── Borehole detail sheet: notes, photos, directions, edit ─────────

import {
  $, $$, esc, sheet, closeSheet, modalForm, confirmDlg, toast, viewPhoto, viewPhotos,
  fmtDateTime, fmtFt, compressImage, uuid, isIOS, toLocalInput, nowISO,
} from './util.js';
import {
  S, findRow, save, softDelete, notesFor, newNote, newRun, addPhotoBlob, photoURL, videosFor,
  canISeeVideos, canUseJob,
} from './store.js';
import { kick } from './sync.js';
import { videoCard, wireVideoCards } from './videos.js';

let openSeq = 0; // last-tapped well wins if two sheets race to open

export async function openWell(id) {
  const seq = ++openSeq;
  const b = findRow('boreholes', id);
  if (!b || b.deleted) return;
  const notes = notesFor(id);
  const surfaceURL = await photoURL(b.photo);
  if (seq !== openSeq) return; // a newer openWell superseded this one

  const pending = []; // composer photo attachments: {path, blob, url}
  // one Directions button that opens the right maps app for the device
  const dirUrl = isIOS()
    ? `https://maps.apple.com/?daddr=${b.lat},${b.lng}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=driving`;
  const el = sheet(`
    <div class="well-head">
      <div class="well-head-main">
        <h3 class="well-name">${esc(b.name)} <button class="icon-btn" id="w-rename" title="Rename">${ic('pencil')}</button></h3>
        <div class="well-meta">Added by ${esc(b.created_by || '?')} · ${fmtDateTime(b.created_at)}</div>
        <div class="well-meta mono">${b.lat.toFixed(6)}, ${b.lng.toFixed(6)}</div>
      </div>
      <button class="icon-btn sheet-x" id="w-close" title="Close">${ic('x')}</button>
    </div>

    <div class="well-actions">
      <a class="btn primary" id="w-gmaps" target="_blank" rel="noopener"
         href="${dirUrl}">${ic('nav')} Directions</a>
      <button class="btn" id="w-share">${ic('share')} Send</button>
      ${canUseJob() ? `<button class="btn" id="w-run">${ic('bolt')} Log run</button>` : ''}
    </div>

    <div class="well-data">
      <div class="well-data-head"><h4>Well data</h4>
        <button class="btn small ghost" id="w-depths">${ic('pencil')} Edit</button></div>
      <div class="depth-row"><span>Roof level</span><b>${b.roof_level ? esc(fmtFt(b.roof_level)) : '—'}</b></div>
      <div class="depth-row"><span>Bottom of casing</span><b>${b.casing_bottom ? esc(fmtFt(b.casing_bottom)) : '—'}</b></div>
      <div class="depth-row"><span>Mine floor</span><b>${b.mine_floor ? esc(fmtFt(b.mine_floor)) : '—'}</b></div>
    </div>

    <div class="well-photo-block">
      ${surfaceURL
        ? `<img class="well-photo" id="w-photo" src="${esc(surfaceURL)}" alt="surface photo"
               crossorigin="anonymous" onerror="this.style.display='none'">
           <button class="btn small ghost" id="w-photo-change">${ic('camera')} Change photo</button>`
        : `<button class="btn big" id="w-photo-add">${ic('camera')} Add surface photo</button>`}
      <input type="file" id="w-photo-input" accept="image/*" capture="environment" hidden>
    </div>

    <div class="well-tools">
      <button class="btn small ghost" id="w-move">${ic('move')} Move pin</button>
      ${S.owner ? `<button class="btn small danger-ghost" id="w-delete">${ic('trash')} Delete</button>` : ''}
    </div>

    <div id="w-videos-block"></div>

    <h4 class="notes-title">Notes <span class="count">${notes.length}</span></h4>
    <div class="note-composer">
      <textarea id="n-text" rows="2" placeholder="Add a note…"></textarea>
      <div class="composer-row">
        <button class="icon-btn" id="n-camera" title="Attach photos">${ic('camera')}</button>
        <div id="n-previews" class="previews"></div>
        <button class="btn primary small" id="n-post">Post</button>
      </div>
      <input type="file" id="n-photo-input" accept="image/*" capture="environment" multiple hidden>
    </div>
    <div class="notes-list" id="notes-list"><div class="loading">…</div></div>

    <button class="btn big ghost sheet-done" id="w-done">Done</button>
  `, { onClose: () => {
    pending.forEach(p => URL.revokeObjectURL(p.url));
    // stop any video still streaming inside the closed sheet
    $$('.video-player', el).forEach(p => { p.hidden = true; p.innerHTML = ''; });
  } });

  renderNotes(el, b);
  // videos section re-renders itself after a delete, so the card list and
  // count stay honest without touching the rest of the sheet
  const renderWellVideos = () => {
    const wrap = $('#w-videos-block', el);
    if (!wrap) return;
    if (!canISeeVideos()) { wrap.innerHTML = ''; return; } // owner-granted only
    const vids = videosFor(id);
    wrap.innerHTML = vids.length ? `
      <h4 class="notes-title">Inspection videos <span class="count">${vids.length}</span></h4>
      <div class="well-videos">${vids.map(v => videoCard(v, b.name)).join('')}</div>` : '';
    const box = $('.well-videos', wrap);
    if (box) wireVideoCards(box, renderWellVideos);
  };
  renderWellVideos();

  // close / done
  $('#w-close', el).onclick = () => closeSheet();
  $('#w-done', el).onclick = () => closeSheet();

  // send location to someone (native share sheet, or copy the link)
  $('#w-share', el).onclick = async () => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}`;
    const data = { title: b.name, text: `${b.name} — borehole location`, url };
    if (navigator.share) {
      try { await navigator.share(data); } catch { /* cancelled */ }
    } else {
      try { await navigator.clipboard.writeText(`${b.name}: ${url}`); toast('Location link copied', 'ok'); }
      catch { toast('Could not share on this device', 'warn'); }
    }
  };

  // well data (depths)
  $('#w-depths', el).onclick = async () => {
    const cur = findRow('boreholes', id);
    const res = await modalForm({
      title: 'Well data',
      fields: [
        { name: 'roof_level', label: 'Roof level (ft)', type: 'number', inputmode: 'decimal', value: cur.roof_level || '', placeholder: 'e.g. 412' },
        { name: 'casing_bottom', label: 'Bottom of casing (ft)', type: 'number', inputmode: 'decimal', value: cur.casing_bottom || '', placeholder: 'e.g. 380' },
        { name: 'mine_floor', label: 'Mine floor (ft)', type: 'number', inputmode: 'decimal', value: cur.mine_floor || '', placeholder: 'e.g. 450' },
      ],
    });
    if (!res) return;
    const roof_level = (res.roof_level || '').trim();
    const casing_bottom = (res.casing_bottom || '').trim();
    const mine_floor = (res.mine_floor || '').trim();
    await save('boreholes', { ...findRow('boreholes', id), roof_level, casing_bottom, mine_floor });
    // update just the depth cells so a half-typed note + photos survive
    const rows = $$('.well-data .depth-row b', el);
    if (rows[0]) rows[0].textContent = roof_level ? fmtFt(roof_level) : '—';
    if (rows[1]) rows[1].textContent = casing_bottom ? fmtFt(casing_bottom) : '—';
    if (rows[2]) rows[2].textContent = mine_floor ? fmtFt(mine_floor) : '—';
  };

  // rename
  $('#w-rename', el).onclick = async () => {
    const res = await modalForm({
      title: 'Rename borehole',
      fields: [{ name: 'name', label: 'Name', value: b.name, required: true }],
    });
    if (res && res.name.trim()) {
      await save('boreholes', { ...findRow('boreholes', id), name: res.name.trim() });
      openWell(id);
    }
  };

  // surface photo
  const photoInput = $('#w-photo-input', el);
  const pickSurface = () => photoInput.click();
  const addBtn = $('#w-photo-add', el); if (addBtn) addBtn.onclick = pickSurface;
  const chgBtn = $('#w-photo-change', el); if (chgBtn) chgBtn.onclick = pickSurface;
  const imgEl = $('#w-photo', el);
  if (imgEl) imgEl.onclick = () => viewPhoto(imgEl.src);
  photoInput.onchange = async () => {
    const f = photoInput.files[0];
    if (!f) return;
    try {
      const blob = await compressImage(f);
      const path = `${id}/${uuid()}.jpg`;
      await addPhotoBlob(path, blob);
      await save('boreholes', { ...findRow('boreholes', id), photo: path });
      kick();
      toast('Surface photo saved', 'ok');
      openWell(id);
    } catch { toast('Could not read that photo', 'warn'); }
  };

  // move pin
  $('#w-move', el).onclick = async () => {
    closeSheet();
    const { armPlacing } = await import('./map.js');
    armPlacing(async latlng => {
      await save('boreholes', { ...findRow('boreholes', id), lat: latlng.lat, lng: latlng.lng });
      toast('Pin moved', 'ok');
      openWell(id);
    }, `Line up the pin for ${b.name}`, [b.lat, b.lng]);
  };

  // delete (owner only)
  const delBtn = $('#w-delete', el);
  if (delBtn) delBtn.onclick = async () => {
    if (await confirmDlg(`Delete ${b.name} and its notes for everyone?`, { okText: 'Delete', danger: true })) {
      await softDelete('boreholes', findRow('boreholes', id));
      closeSheet();
      toast(`${b.name} deleted`, 'ok');
    }
  };

  // log run (owner only)
  const runBtn = $('#w-run', el);
  if (runBtn) runBtn.onclick = async () => {
    const res = await modalForm({
      title: `Log run — ${b.name}`,
      fields: [
        { name: 'ts', label: 'Date & time', type: 'datetime-local', value: toLocalInput(), required: true },
        { name: 'note', label: 'Note (optional)', placeholder: 'e.g. gamma run' },
      ],
      okText: 'Log run',
    });
    if (!res) return;
    if (!res.ts || isNaN(new Date(res.ts))) { toast('Enter a valid date & time', 'warn'); return; }
    await newRun(id, new Date(res.ts).toISOString(), res.note || '');
    toast(`Run logged at ${b.name}`, 'ok');
  };

  // note composer — previewsEl/postBtn are captured per render, so a photo
  // that finishes compressing after the sheet re-rendered lands in a
  // detached node instead of leaking into the new composer
  const previewsEl = $('#n-previews', el);
  const postBtn = $('#n-post', el);
  const nInput = $('#n-photo-input', el);
  let busy = 0; // photos still compressing — Post stays disabled
  const renderPreviews = () => {
    previewsEl.innerHTML = pending.map((p, i) =>
      `<img class="preview" src="${p.url}" data-i="${i}" title="Tap to remove">`).join('');
    $$('.preview', previewsEl).forEach(im => im.onclick = () => {
      const [gone] = pending.splice(Number(im.dataset.i), 1);
      if (gone) URL.revokeObjectURL(gone.url);
      renderPreviews();
    });
  };
  $('#n-camera', el).onclick = () => nInput.click();
  nInput.onchange = async () => {
    const files = [...nInput.files];
    nInput.value = '';
    busy++;
    postBtn.disabled = true;
    for (const f of files) {
      try {
        const blob = await compressImage(f);
        pending.push({ path: `${id}/${uuid()}.jpg`, blob, url: URL.createObjectURL(blob) });
        renderPreviews();
      } catch { toast('Skipped a photo that could not be read', 'warn'); }
    }
    if (--busy === 0) postBtn.disabled = false;
  };
  postBtn.onclick = async () => {
    if (busy || postBtn.disabled) return;
    const text = $('#n-text', el).value.trim();
    if (!text && !pending.length) return;
    postBtn.disabled = true; // no double-tap double-post
    try {
      for (const p of pending) await addPhotoBlob(p.path, p.blob);
      await newNote(id, text, pending.map(p => p.path));
      kick();
      openWell(id); // re-render with the new note
    } finally { postBtn.disabled = false; }
  };
}

async function renderNotes(el, b) {
  const wrap = $('#notes-list', el);
  const notes = notesFor(b.id);
  if (!notes.length) {
    wrap.innerHTML = `<div class="empty-hint">No notes yet — anything you post here is visible to the whole crew.</div>`;
    return;
  }
  const blocks = await Promise.all(notes.map(async n => {
    const photos = await Promise.all((n.photos || []).map(p => photoURL(p)));
    const mine = n.author_id === S.profile?.id;
    return `
      <div class="note">
        <div class="note-head">
          <span class="note-author">${esc(n.author)}</span>
          <span class="note-time">${fmtDateTime(n.created_at)}</span>
          ${(mine || S.owner) ? `<button class="icon-btn tiny" data-del="${n.id}" title="Delete note">${ic('trash')}</button>` : ''}
        </div>
        ${n.text ? `<div class="note-text">${esc(n.text)}</div>` : ''}
        ${photos.filter(Boolean).length
          ? `<div class="note-photos">${photos.filter(Boolean).map(u =>
              `<img class="note-photo" src="${esc(u)}" loading="lazy"
                    crossorigin="anonymous" onerror="this.style.display='none'">`).join('')}</div>`
          : ''}
      </div>`;
  }));
  wrap.innerHTML = blocks.join('');
  // each note's photos browse as one little gallery (swipe / arrows)
  $$('.note-photos', wrap).forEach(box => {
    const imgs = [...box.querySelectorAll('.note-photo')];
    const urls = imgs.map(im => im.src);
    imgs.forEach((im, idx) => im.onclick = () => viewPhotos(urls, idx));
  });
  $$('[data-del]', wrap).forEach(btn => btn.onclick = async () => {
    if (await confirmDlg('Delete this note?', { okText: 'Delete', danger: true })) {
      await softDelete('notes', findRow('notes', btn.dataset.del));
      // re-render only the notes list so a half-typed note in the
      // composer (text + attached photos) survives the deletion
      renderNotes(el, b);
      const count = $('.notes-title .count', el);
      if (count) count.textContent = notesFor(b.id).length;
    }
  });
}

function ic(name) {
  const p = {
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    nav: '<path d="M3 11l19-9-9 19-2-8-8-2z"/>',
    apple: '<path d="M12 4c1-2 3-2 3-2s.2 2-1 3.5S11 7 11 7s-.2-1.8 1-3zM16.5 8c-1.7 0-2.4.9-3.5.9S11.2 8 9.5 8C7.3 8 5 9.9 5 13.4c0 3.6 2.6 7.6 4.3 7.6 1 0 1.4-.7 2.7-.7s1.7.7 2.7.7c1.8 0 4.3-4.1 4.3-5.9-2-.8-2.6-3.6-.6-4.9C17.6 8.5 16.5 8 16.5 8z" fill="currentColor" stroke="none"/>',
    bolt: '<path d="M13 2 3 14h7l-1 8 12-14h-8l1-6z"/>',
    share: '<path d="M12 2v14M8 6l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  };
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p[name]}</svg>`;
}
