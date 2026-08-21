// ── Reports: print-ready pages (well depths + daily overview) ──────
// Clean white pages. Print / Save as PDF from the browser; Close
// returns to the app untouched.

import { $, esc, toast, fmtDate, fmtTime, fmtDur, fmtFt, ymd } from './util.js';
import {
  S, activeBoreholes, isWell, projectName, findRow,
  activeRuns, activeShifts, activeVideos, activeExpenses, canUseJob,
} from './store.js';

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
// Everything the app knows about one day: pins added, notes, uploaded
// inspections — plus the viewer's own runs / field hours / expenses
// (private books never mix, so this only ever shows YOUR job numbers).
const dayOf = iso => (iso ? ymd(new Date(iso)) : '');
const wellName = id => { const b = findRow('boreholes', id); return b ? b.name : 'Unknown well'; };

export function openDailyReport(dateStr) {
  const isToday = dateStr === ymd(new Date());
  const niceDay = fmtDate(dateStr + 'T12:00');
  const job = canUseJob();

  const pins = activeBoreholes().filter(b => dayOf(b.created_at) === dateStr);
  const notes = S.notes.filter(n => !n.deleted && dayOf(n.created_at) === dateStr)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const vids = activeVideos().filter(v => dayOf(v.ts) === dateStr);
  const runs = job ? activeRuns().filter(r => dayOf(r.ts) === dateStr)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))) : [];
  const shifts = job ? activeShifts().filter(s =>
    dayOf(s.start_ts) === dateStr || (s.end_ts && dayOf(s.end_ts) === dateStr))
    .sort((a, b) => String(a.start_ts).localeCompare(String(b.start_ts))) : [];
  const exps = job ? activeExpenses().filter(x => dayOf(x.ts + 'T12:00') === dateStr) : [];

  const closedMs = shifts.reduce((sum, s) =>
    sum + (s.end_ts ? (new Date(s.end_ts) - new Date(s.start_ts)) : 0), 0);
  const openShift = shifts.find(s => !s.end_ts);

  const stats = [
    job && (closedMs || openShift) ? `<span><b>${closedMs ? fmtDur(closedMs) : '—'}</b> in the field${openShift ? ' (+ still out)' : ''}</span>` : '',
    job && runs.length ? `<span><b>${runs.length}</b> run${runs.length === 1 ? '' : 's'}</span>` : '',
    vids.length ? `<span><b>${vids.length}</b> inspection${vids.length === 1 ? '' : 's'}</span>` : '',
    pins.length ? `<span><b>${pins.length}</b> pin${pins.length === 1 ? '' : 's'} added</span>` : '',
    notes.length ? `<span><b>${notes.length}</b> note${notes.length === 1 ? '' : 's'}</span>` : '',
    job && exps.length ? `<span><b>$${exps.reduce((s, x) => s + (Number(x.amount) || 0), 0).toFixed(2)}</b> expenses</span>` : '',
  ].filter(Boolean).join('');

  const sec = (title, inner) => (inner ? `<div class="rep-sec">${title}</div>${inner}` : '');
  const table = (heads, rows) => (rows.length ? `
    <table class="rep-table">
      <thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>` : '');

  const hoursRows = shifts.map(s => `<tr>
    <td>${fmtTime(s.start_ts)} → ${s.end_ts ? fmtTime(s.end_ts) : 'still out'}</td>
    <td>${s.end_ts ? fmtDur(new Date(s.end_ts) - new Date(s.start_ts)) : '—'}</td>
  </tr>`);
  const runRows = runs.map(r => `<tr>
    <td class="rep-name">${esc(wellName(r.borehole_id))}</td>
    <td>${fmtTime(r.ts)}</td><td>${esc(r.note || '')}</td>
  </tr>`);
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
  const expRows = exps.map(x => `<tr>
    <td class="rep-name">${esc(x.label)}</td>
    <td>$${(Number(x.amount) || 0).toFixed(2)}</td>
  </tr>`);
  const noteBlocks = notes.map(n => `
    <div class="rep-note">
      <div class="rep-note-head"><b>${esc(wellName(n.borehole_id))}</b>
        · ${fmtTime(n.created_at)} · ${esc(n.author || '')}
        ${(n.photos || []).length ? ` · ${(n.photos || []).length} photo${(n.photos || []).length === 1 ? '' : 's'}` : ''}</div>
      ${n.text ? `<div class="rep-note-text">${esc(n.text)}</div>` : ''}
    </div>`).join('');

  const body =
    sec('Field hours', table(['In → out', 'Hours'], hoursRows)) +
    sec('Runs', table(['Borehole', 'Time', 'Note'], runRows)) +
    sec('Inspections uploaded', table(['Borehole', 'Time', 'Screenshots', 'By'], vidRows)) +
    sec('Pins added', table(['Name', 'Type', 'Time', 'By'], pinRows)) +
    sec('Notes', noteBlocks) +
    sec('Expenses', table(['What for', 'Cost'], expRows));

  mountReport(`
    ${repHead('Daily Overview', `${niceDay}${isToday ? ` · up to ${fmtTime(new Date())}` : ''}`)}
    ${stats ? `<div class="rep-stats">${stats}</div>` : ''}
    ${body || `<div class="rep-empty">Nothing recorded on this day.</div>`}
    ${repFoot()}`);
}
