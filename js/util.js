// ── Shared helpers: DOM, events, formatting, UI primitives ─────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

export const nowISO = () => new Date().toISOString();

// ── Event bus ──────────────────────────────────────────────────────
const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, e => fn(e.detail));

// ── Escaping / formatting ──────────────────────────────────────────
export const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtDate = iso => {
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
export const fmtTime = iso => {
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
export const fmtDateTime = iso => `${fmtDate(iso)} · ${fmtTime(iso)}`;

export const fmtDur = ms => {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

export const dateOnly = d => {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
};
export const daysBetween = (a, b) =>
  Math.round((dateOnly(b) - dateOnly(a)) / 86400000);

// Local YYYY-MM-DD (for grouping by day and <input type=date>)
export const ymd = d => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
// For <input type="datetime-local">
export const toLocalInput = iso => {
  const d = iso ? new Date(iso) : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ── Geo ────────────────────────────────────────────────────────────
export function haversineM(a, b) {
  const R = 6371000, toR = x => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export function fmtDist(m) {
  const mi = m / 1609.344;
  if (mi < 0.19) return `${Math.round(m * 3.28084)} ft`;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}
// Depth values: append "ft" to a bare number, otherwise show as entered.
export function fmtFt(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  return /^\d+(\.\d+)?$/.test(s) ? `${s} ft` : s;
}

// ── Phone numbers ──────────────────────────────────────────────────
// Return the 10 digits of a US cell, or null if it isn't a valid one.
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1); // strip country code
  return d.length === 10 ? d : null;
}
export function formatPhone(raw) {
  const d = normalizePhone(raw);
  if (!d) return String(raw ?? '');
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Toasts ─────────────────────────────────────────────────────────
export function toast(msg, kind = 'info') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

// ── Bottom sheet (one at a time) ───────────────────────────────────
let sheetCloseFn = null;
export function sheet(html, { onClose } = {}) {
  closeSheet();
  const backdrop = $('#sheet-backdrop'), el = $('#sheet');
  el.innerHTML = `<div class="sheet-handle"></div>${html}`;
  backdrop.classList.add('open');
  el.classList.add('open');
  document.body.classList.add('sheet-open');
  sheetCloseFn = () => {
    backdrop.classList.remove('open');
    el.classList.remove('open');
    document.body.classList.remove('sheet-open');
    sheetCloseFn = null;
    if (onClose) onClose();
  };
  backdrop.onclick = () => closeSheet();
  return el;
}
export function closeSheet() { if (sheetCloseFn) sheetCloseFn(); }

// ── Center modal dialogs ───────────────────────────────────────────
function openModal(html) {
  const backdrop = $('#modal-backdrop'), el = $('#modal');
  el.innerHTML = html;
  backdrop.classList.add('open');
  el.classList.add('open');
  return el;
}
export function closeModal() {
  $('#modal-backdrop').classList.remove('open');
  $('#modal').classList.remove('open');
}

// Ask for a line (or small form) of text. fields: [{name,label,value,type,placeholder,required}]
export function modalForm({ title, fields, okText = 'Save', danger = false }) {
  return new Promise(resolve => {
    const el = openModal(`
      <h3>${esc(title)}</h3>
      <form id="modal-form">
        ${fields.map(f => `
          <label class="field">
            <span>${esc(f.label)}</span>
            ${f.type === 'textarea'
              ? `<textarea name="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}" rows="3">${esc(f.value || '')}</textarea>`
              : `<input name="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(f.value || '')}"
                   placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}
                   autocomplete="off" enterkeyhint="done">`}
          </label>`).join('')}
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(okText)}</button>
        </div>
      </form>`);
    const done = val => { closeModal(); resolve(val); };
    $('#modal-cancel', el).onclick = () => done(null);
    $('#modal-backdrop').onclick = () => done(null);
    $('#modal-form', el).onsubmit = e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      done(data);
    };
    const first = el.querySelector('input,textarea');
    if (first) setTimeout(() => first.focus(), 60);
  });
}

export function confirmDlg(msg, { okText = 'OK', danger = false, title = 'Are you sure?' } = {}) {
  return new Promise(resolve => {
    const el = openModal(`
      <h3>${esc(title)}</h3>
      <p class="modal-msg">${esc(msg)}</p>
      <div class="modal-actions">
        <button class="btn ghost" id="c-no">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="c-yes">${esc(okText)}</button>
      </div>`);
    const done = v => { closeModal(); resolve(v); };
    $('#c-no', el).onclick = () => done(false);
    $('#c-yes', el).onclick = () => done(true);
    $('#modal-backdrop').onclick = () => done(false);
  });
}

// Fullscreen photo viewer
export function viewPhoto(src) {
  const el = openModal(`<img class="photo-full" src="${esc(src)}" alt="photo" crossorigin="anonymous">`);
  el.classList.add('photo-modal');
  const close = () => { el.classList.remove('photo-modal'); closeModal(); };
  el.onclick = close;
  $('#modal-backdrop').onclick = close;
}

// ── Image compression (camera photos → ~1600px JPEG) ───────────────
export function compressImage(file, maxDim = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      if (Math.max(w, h) > maxDim) {
        const k = maxDim / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('compress failed'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

export function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
