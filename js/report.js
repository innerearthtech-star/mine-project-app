// ── Reports: print-ready pages (well depths + daily overview) ──────
// Clean white pages. Print / Save as PDF from the browser; Close
// returns to the app untouched.

import { $, esc, toast, fmtDate, fmtTime, fmtFt, ymd } from './util.js';
import { S, activeBoreholes, isWell, projectName, findRow, activeVideos } from './store.js';

// shared overlay scaffold — one report on screen at a time
function mountReport(pageHTML) {
  let view = $('#report-view');
  if (view) view.remove();
  view = document.createElement('div');
  view.id = 'report-view';
  view.innerHTML = `
    <div class="rep-actions">
      <button class="btn small ghost" id="rep-close">✕ Close</button>
      <span class="rep-actions-spacer"></span>
      <button class="btn small primary" id="rep-print">🖨 Print / Save PDF</button>
    </div>
    <div class="rep-page">${pageHTML}</div>`;
  document.body.appendChild(view);
  $('#rep-close', view).onclick = () => view.remove();
  $('#rep-print', view).onclick = () => window.print();
  return view;
}

const repHead = (title, sub) => `
  <div class="rep-head">
    <div>
      <div class="rep-title">${esc(projectName())} Project — ${title}</div>
      <div class="rep-sub">${sub}</div>
    </div>
    <div class="rep-brand">Inner Earth Tech</div>
  </div>`;

const repFoot = () =>
  `<div class="rep-foot">Generated ${fmtDate(new Date())} · ${esc(projectName())} Project app by Inner Earth Tech</div>`;

// ── Well depths ────────────────────────────────────────────────────
export function openWellReport() {
  const wells = activeBoreholes().filter(isWell);
  if (!wells.length) { toast('No boreholes yet', 'warn'); return; }

  mountReport(`
    ${repHead('Well Depths', `${fmtDate(new Date())} · ${wells.length} borehole${wells.length === 1 ? '' : 's'}`)}
    <table class="rep-table">
      <thead><tr>
        <th>Borehole</th><th>Roof level</th><th>Bottom of casing</th><th>Mine floor</th>
      </tr></thead>
      <tbody>
        ${wells.map(b => `<tr>
          <td class="rep-name">${esc(b.name)}</td>
          <td>${b.roof_level ? esc(fmtFt(b.roof_level)) : '—'}</td>
          <td>${b.casing_bottom ? esc(fmtFt(b.casing_bottom)) : '—'}</td>
          <td>${b.mine_floor ? esc(fmtFt(b.mine_floor)) : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${repFoot()}`);
}

// ── Daily overview ─────────────────────────────────────────────────
// A customer-facing snapshot of one day: inspections run, pins added,
// and field notes. Deliberately NO job-book data (hours, runs,
// expenses) — that stays private in the My Job tab.
const dayOf = iso => (iso ? ymd(new Date(iso)) : '');
const wellName = id => { const b = findRow('boreholes', id); return b ? b.name : 'Unknown well'; };

export function openDailyReport(dateStr) {
  const isToday = dateStr === ymd(new Date());
  const niceDay = fmtDate(dateStr + 'T12:00');

  const pins = activeBoreholes().filter(b => dayOf(b.created_at) === dateStr);
  const notes = S.notes.filter(n => !n.deleted && dayOf(n.created_at) === dateStr)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const vids = activeVideos().filter(v => dayOf(v.ts) === dateStr);

  const stats = [
    vids.length ? `<span><b>${vids.length}</b> inspection${vids.length === 1 ? '' : 's'}</span>` : '',
    pins.length ? `<span><b>${pins.length}</b> pin${pins.length === 1 ? '' : 's'} added</span>` : '',
    notes.length ? `<span><b>${notes.length}</b> note${notes.length === 1 ? '' : 's'}</span>` : '',
  ].filter(Boolean).join('');

  const sec = (title, inner) => (inner ? `<div class="rep-sec">${title}</div>${inner}` : '');
  const table = (heads, rows) => (rows.length ? `
    <table class="rep-table">
      <thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>` : '');

  const vidRows = vids.map(v => `<tr>
    <td class="rep-name">${esc(wellName(v.borehole_id))}</td>
    <td>${fmtTime(v.ts)}</td>
    <td>${(v.screenshots || []).length ? `${(v.screenshots || []).length} screenshot${(v.screenshots || []).length === 1 ? '' : 's'}` : ''}</td>
    <td>${esc(v.uploaded_by || '')}</td>
  </tr>`);
  const pinRows = pins.map(b => `<tr>
    <td class="rep-name">${esc(b.name)}</td>
    <td>${isWell(b) ? 'Borehole' : 'Landmark'}</td>
    <td>${fmtTime(b.created_at)}</td>
    <td>${esc(b.created_by || '')}</td>
  </tr>`);
  const noteBlocks = notes.map(n => `
    <div class="rep-note">
      <div class="rep-note-head"><b>${esc(wellName(n.borehole_id))}</b>
        · ${fmtTime(n.created_at)} · ${esc(n.author || '')}
        ${(n.photos || []).length ? ` · ${(n.photos || []).length} photo${(n.photos || []).length === 1 ? '' : 's'}` : ''}</div>
      ${n.text ? `<div class="rep-note-text">${esc(n.text)}</div>` : ''}
    </div>`).join('');

  const body =
    sec('Inspections run', table(['Borehole', 'Time', 'Screenshots', 'By'], vidRows)) +
    sec('Pins added', table(['Name', 'Type', 'Time', 'By'], pinRows)) +
    sec('Field notes', noteBlocks);

  mountReport(`
    ${repHead('Daily Overview', `${niceDay}${isToday ? ` · up to ${fmtTime(new Date())}` : ''}`)}
    ${stats ? `<div class="rep-stats">${stats}</div>` : ''}
    ${body || `<div class="rep-empty">Nothing recorded on this day.</div>`}
    ${repFoot()}`);
}
