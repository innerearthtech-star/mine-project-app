// ── Borehole detail sheet: notes, photos, directions, edit ─────────

import {
  $, $$, esc, sheet, closeSheet, modalForm, confirmDlg, toast, viewPhoto,
  fmtDateTime, compressImage, uuid, isIOS, toLocalInput, nowISO,
} from './util.js';
import {
  S, findRow, save, softDelete, notesFor, newNote, newRun, addPhotoBlob, photoURL,
} from './store.js';
import { kick } from './sync.js';

export async function openWell(id) {
  const b = findRow('boreholes', id);
  if (!b || b.deleted) return;
  const notes = notesFor(id);
  const surfaceURL = await photoURL(b.photo);

  const el = sheet(`
    <div class="well-head">
      <div>
        <h3 class="well-name">${esc(b.name)} <button class="icon-btn" id="w-rename" title="Rename">${ic('pencil')}</button></h3>
        <div class="well-meta">Added by ${esc(b.created_by || '?')} · ${fmtDateTime(b.created_at)}</div>
        <div class="well-meta mono">${b.lat.toFixed(6)}, ${b.lng.toFixed(6)}</div>
      </div>
    </div>

    <div class="well-actions">
      <a class="btn primary" id="w-gmaps" target="_blank" rel="noopener"
         href="https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=driving">
         ${ic('nav')} Directions</a>
      ${isIOS() ? `<a class="btn" target="_blank" rel="noopener"
         href="https://maps.apple.com/?daddr=${b.lat},${b.lng}">${ic('apple')} Apple Maps</a>` : ''}
      ${S.owner ? `<button class="btn" id="w-run">${ic('bolt')} Log run</button>` : ''}
    </div>

    <div class="well-photo-block">
      ${surfaceURL
        ? `<img class="well-photo" id="w-photo" src="${esc(surfaceURL)}" alt="surface photo">
           <button class="btn small ghost" id="w-photo-change">${ic('camera')} Change photo</button>`
        : `<button class="btn big" id="w-photo-add">${ic('camera')} Add surface photo</button>`}
      <input type="file" id="w-photo-input" accept="image/*" capture="environment" hidden>
    </div>

    <div class="well-tools">
      <button class="btn small ghost" id="w-move">${ic('move')} Move pin</button>
      ${S.owner ? `<button class="btn small danger-ghost" id="w-delete">${ic('trash')} Delete</button>` : ''}
    </div>

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
  `);

  renderNotes(el, b);

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
    }, `Tap the new location for ${b.name}`);
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
        { name: 'ts', label: 'Date & time', type: 'datetime-local', value: toLocalInput() },
        { name: 'note', label: 'Note (optional)', placeholder: 'e.g. gamma run' },
      ],
      okText: 'Log run',
    });
    if (!res) return;
    await newRun(id, new Date(res.ts).toISOString(), res.note || '');
    toast(`Run logged at ${b.name}`, 'ok');
  };

  // note composer
  const pending = []; // {path, blob, url}
  const nInput = $('#n-photo-input', el);
  $('#n-camera', el).onclick = () => nInput.click();
  nInput.onchange = async () => {
    for (const f of nInput.files) {
      try {
        const blob = await compressImage(f);
        const path = `${id}/${uuid()}.jpg`;
        pending.push({ path, blob, url: URL.createObjectURL(blob) });
      } catch { toast('Skipped a photo that could not be read', 'warn'); }
    }
    nInput.value = '';
    $('#n-previews', el).innerHTML = pending.map((p, i) =>
      `<img class="preview" src="${p.url}" data-i="${i}" title="Tap to remove">`).join('');
    $$('.preview', el).forEach(im => im.onclick = () => {
      pending.splice(Number(im.dataset.i), 1);
      im.remove();
    });
  };
  $('#n-post', el).onclick = async () => {
    const text = $('#n-text', el).value.trim();
    if (!text && !pending.length) return;
    for (const p of pending) await addPhotoBlob(p.path, p.blob);
    await newNote(id, text, pending.map(p => p.path));
    kick();
    openWell(id); // re-render with the new note
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
              `<img class="note-photo" src="${esc(u)}" loading="lazy">`).join('')}</div>`
          : ''}
      </div>`;
  }));
  wrap.innerHTML = blocks.join('');
  $$('.note-photo', wrap).forEach(im => im.onclick = () => viewPhoto(im.src));
  $$('[data-del]', wrap).forEach(btn => btn.onclick = async () => {
    if (await confirmDlg('Delete this note?', { okText: 'Delete', danger: true })) {
      await softDelete('notes', findRow('notes', btn.dataset.del));
      openWell(b.id);
    }
  });
}

function ic(name) {
  const p = {
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    nav: '<path d="M3 11l19-9-9 19-2-8-8-2z"/>',
    apple: '<path d="M12 4c1-2 3-2 3-2s.2 2-1 3.5S11 7 11 7s-.2-1.8 1-3zM16.5 8c-1.7 0-2.4.9-3.5.9S11.2 8 9.5 8C7.3 8 5 9.9 5 13.4c0 3.6 2.6 7.6 4.3 7.6 1 0 1.4-.7 2.7-.7s1.7.7 2.7.7c1.8 0 4.3-4.1 4.3-5.9-2-.8-2.6-3.6-.6-4.9C17.6 8.5 16.5 8 16.5 8z" fill="currentColor" stroke="none"/>',
    bolt: '<path d="M13 2 3 14h7l-1 8 12-14h-8l1-6z"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  };
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p[name]}</svg>`;
}
