// ── My Job tab (owner only): field hours, runs, night stays, export ─

import {
  $, $$, esc, on, toast, confirmDlg, modalForm, fmtDate, fmtTime, fmtDur,
  toLocalInput, daysBetween, ymd, download,
} from './util.js';
import {
  S, findRow, save, softDelete, activeBoreholes, activeRuns, activeShifts,
  activeJobs, openShift, currentJob, newRun, newShift, newJob,
} from './store.js';

let clockTimer = null;

export function initJob() {
  ['data:runs', 'data:shifts', 'data:jobs', 'data:boreholes', 'owner'].forEach(ev =>
    on(ev, () => { if (S.owner) renderJob(); }));
}

export function renderJob() {
  const root = $('#view-job .tab-body');
  if (!S.owner) { root.innerHTML = ''; return; }

  const runs = activeRuns();
  const shifts = activeShifts();
  const open = openShift();
  const job = currentJob();
  const totalMs = shifts.reduce((sum, s) =>
    sum + (s.end_ts ? (new Date(s.end_ts) - new Date(s.start_ts)) : 0), 0);
  const nights = nightsInfo(job);

  root.innerHTML = `
    <div class="stat-row">
      <div class="stat"><div class="stat-num">${runs.length}</div><div class="stat-label">runs</div></div>
      <div class="stat"><div class="stat-num">${(totalMs / 3600000).toFixed(1)}</div><div class="stat-label">field hours</div></div>
      <div class="stat"><div class="stat-num">${nights.count}</div><div class="stat-label">night stays</div></div>
    </div>

    <section class="card">
      <h4>Field hours</h4>
      ${open ? `
        <div class="clock-live">In the field since <b>${fmtTime(open.start_ts)}</b> — <b id="live-dur">${fmtDur(Date.now() - new Date(open.start_ts))}</b></div>
        <button class="btn danger big" id="btn-shift">Back at hotel — clock out</button>
      ` : `
        <button class="btn primary big" id="btn-shift">Leaving hotel — clock in</button>
      `}
      <div class="shift-list">
        ${shifts.slice(0, 30).map(s => `
          <button class="row" data-shift="${s.id}">
            <span>${fmtDate(s.start_ts)}</span>
            <span class="row-mid">${fmtTime(s.start_ts)} → ${s.end_ts ? fmtTime(s.end_ts) : '…'}</span>
            <span class="row-strong">${s.end_ts ? fmtDur(new Date(s.end_ts) - new Date(s.start_ts)) : 'open'}</span>
          </button>`).join('')}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h4>Runs by borehole</h4>
        <button class="btn small primary" id="btn-add-run">+ Log run</button></div>
      ${renderRunGroups(runs)}
    </section>

    <section class="card">
      <h4>Night stays</h4>
      ${job ? `
        <div class="night-live">Night <b>${nights.count}</b> tonight · started ${fmtDate(job.night_start + 'T12:00')}</div>
        <div class="night-sub">Counting automatically — every night adds one until you finish.</div>
        <button class="btn big" id="btn-finish-job">Finish job — stop counting</button>
      ` : `
        <div class="night-sub">Tap when you check in for your first night — nights count automatically after that.</div>
        <button class="btn primary big" id="btn-start-job">Start night stays (first night tonight)</button>
      `}
      ${pastJobs()}
    </section>

    <section class="card">
      <h4>Export</h4>
      <button class="btn big" id="btn-export">Download job summary (CSV)</button>
    </section>
  `;

  wireJob(root, { open, job });
  startClock(open);
}

function nightsInfo(job) {
  if (job) {
    // active: count tonight as a night (night 1 on the start date)
    return { count: daysBetween(job.night_start + 'T12:00', new Date()) + 1 };
  }
  const done = activeJobs().filter(j => j.night_end);
  const count = done.reduce((s, j) => s + daysBetween(j.night_start + 'T12:00', j.night_end + 'T12:00'), 0);
  return { count };
}

function renderRunGroups(runs) {
  if (!runs.length) return `<div class="empty-hint">No runs yet — log them here or from a borehole's pin on the map.</div>`;
  const byWell = new Map();
  for (const r of runs) {
    if (!byWell.has(r.borehole_id)) byWell.set(r.borehole_id, []);
    byWell.get(r.borehole_id).push(r);
  }
  return [...byWell.entries()].map(([wellId, list]) => {
    const b = findRow('boreholes', wellId);
    return `
      <details class="run-group">
        <summary><span>${esc(b ? b.name : 'Unknown well')}</span><span class="badge">${list.length}</span></summary>
        ${list.map(r => `
          <button class="row" data-run="${r.id}">
            <span>${fmtDate(r.ts)}</span>
            <span class="row-mid">${fmtTime(r.ts)}</span>
            <span class="row-note">${esc(r.note || '')}</span>
          </button>`).join('')}
      </details>`;
  }).join('');
}

function pastJobs() {
  const done = activeJobs().filter(j => j.night_end);
  if (!done.length) return '';
  return `<div class="past-jobs">${done.map(j =>
    `<div class="row static"><span>${fmtDate(j.night_start + 'T12:00')} → ${fmtDate(j.night_end + 'T12:00')}</span>
     <span class="row-strong">${daysBetween(j.night_start + 'T12:00', j.night_end + 'T12:00')} nights</span></div>`).join('')}</div>`;
}

function wireJob(root, { open, job }) {
  $('#btn-shift', root).onclick = async () => {
    if (open) {
      await save('shifts', { ...findRow('shifts', open.id), end_ts: new Date().toISOString() });
      toast(`Clocked out — ${fmtDur(Date.now() - new Date(open.start_ts))} in the field`, 'ok');
    } else {
      await newShift(new Date().toISOString());
      toast('Clocked in — have a good one ⛏', 'ok');
    }
  };

  // edit a shift
  $$('[data-shift]', root).forEach(el => el.onclick = async () => {
    const s = findRow('shifts', el.dataset.shift);
    const res = await modalForm({
      title: 'Edit day',
      fields: [
        { name: 'start', label: 'Left hotel', type: 'datetime-local', value: toLocalInput(s.start_ts) },
        { name: 'end', label: 'Back at hotel', type: 'datetime-local', value: s.end_ts ? toLocalInput(s.end_ts) : '' },
        { name: 'del', label: 'Type DELETE to remove this day', placeholder: '' },
      ],
    });
    if (!res) return;
    if (res.del === 'DELETE') { await softDelete('shifts', s); toast('Day removed', 'ok'); return; }
    await save('shifts', {
      ...s,
      start_ts: new Date(res.start).toISOString(),
      end_ts: res.end ? new Date(res.end).toISOString() : null,
    });
  });

  $('#btn-add-run', root).onclick = async () => {
    const wells = activeBoreholes();
    if (!wells.length) { toast('Add a borehole on the map first', 'warn'); return; }
    const res = await modalFormWithSelect(wells);
    if (!res) return;
    await newRun(res.well, new Date(res.ts).toISOString(), res.note || '');
    toast('Run logged', 'ok');
  };

  // edit a run
  $$('[data-run]', root).forEach(el => el.onclick = async () => {
    const r = findRow('runs', el.dataset.run);
    const res = await modalForm({
      title: 'Edit run',
      fields: [
        { name: 'ts', label: 'Date & time', type: 'datetime-local', value: toLocalInput(r.ts) },
        { name: 'note', label: 'Note', value: r.note || '' },
        { name: 'del', label: 'Type DELETE to remove this run', placeholder: '' },
      ],
    });
    if (!res) return;
    if (res.del === 'DELETE') { await softDelete('runs', r); toast('Run removed', 'ok'); return; }
    await save('runs', { ...r, ts: new Date(res.ts).toISOString(), note: res.note || '' });
  });

  const startBtn = $('#btn-start-job', root);
  if (startBtn) startBtn.onclick = async () => {
    const res = await modalForm({
      title: 'Start night stays',
      fields: [{ name: 'date', label: 'First night', type: 'date', value: ymd(new Date()) }],
      okText: 'Start counting',
    });
    if (!res) return;
    await newJob(res.date);
    toast('Night stays are counting automatically', 'ok');
  };

  const finishBtn = $('#btn-finish-job', root);
  if (finishBtn) finishBtn.onclick = async () => {
    const res = await modalForm({
      title: 'Finish job',
      fields: [{ name: 'date', label: 'Check-out morning', type: 'date', value: ymd(new Date()) }],
      okText: 'Finish',
    });
    if (!res) return;
    const j = currentJob();
    await save('jobs', { ...j, night_end: res.date });
    toast(`Job finished — ${daysBetween(j.night_start + 'T12:00', res.date + 'T12:00')} nights total`, 'ok');
  };

  $('#btn-export', root).onclick = exportCSV;
}

// run form needs a well dropdown — build it by hand
function modalFormWithSelect(wells) {
  return new Promise(resolve => {
    import('./util.js').then(({ closeModal }) => {
      const backdrop = $('#modal-backdrop'), el = $('#modal');
      el.innerHTML = `
        <h3>Log run</h3>
        <form id="run-form">
          <label class="field"><span>Borehole</span>
            <select name="well">${wells.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
          </label>
          <label class="field"><span>Date & time</span>
            <input name="ts" type="datetime-local" value="${toLocalInput()}"></label>
          <label class="field"><span>Note (optional)</span>
            <input name="note" placeholder="e.g. gamma run"></label>
          <div class="modal-actions">
            <button type="button" class="btn ghost" id="run-cancel">Cancel</button>
            <button type="submit" class="btn primary">Log run</button>
          </div>
        </form>`;
      backdrop.classList.add('open');
      el.classList.add('open');
      const done = v => { closeModal(); resolve(v); };
      $('#run-cancel', el).onclick = () => done(null);
      backdrop.onclick = () => done(null);
      $('#run-form', el).onsubmit = e => {
        e.preventDefault();
        done(Object.fromEntries(new FormData(e.target).entries()));
      };
    });
  });
}

function startClock(open) {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (!open) return;
  clockTimer = setInterval(() => {
    const el = $('#live-dur');
    if (el) el.textContent = fmtDur(Date.now() - new Date(open.start_ts));
    else { clearInterval(clockTimer); clockTimer = null; }
  }, 30000);
}

function exportCSV() {
  const lines = [];
  const wellName = id => { const b = findRow('boreholes', id); return b ? b.name : 'Unknown'; };
  lines.push('RUNS');
  lines.push('Borehole,Date,Time,Note');
  for (const r of activeRuns().slice().reverse()) {
    lines.push(`"${wellName(r.borehole_id)}","${fmtDate(r.ts)}","${fmtTime(r.ts)}","${(r.note || '').replace(/"/g, '""')}"`);
  }
  lines.push('');
  lines.push('FIELD HOURS');
  lines.push('Date,Left hotel,Back at hotel,Hours');
  for (const s of activeShifts().slice().reverse()) {
    const dur = s.end_ts ? ((new Date(s.end_ts) - new Date(s.start_ts)) / 3600000).toFixed(2) : '';
    lines.push(`"${fmtDate(s.start_ts)}","${fmtTime(s.start_ts)}","${s.end_ts ? fmtTime(s.end_ts) : ''}","${dur}"`);
  }
  lines.push('');
  lines.push('NIGHT STAYS');
  lines.push('First night,Checked out,Nights');
  for (const j of activeJobs()) {
    const n = j.night_end
      ? daysBetween(j.night_start + 'T12:00', j.night_end + 'T12:00')
      : daysBetween(j.night_start + 'T12:00', new Date()) + 1;
    lines.push(`"${fmtDate(j.night_start + 'T12:00')}","${j.night_end ? fmtDate(j.night_end + 'T12:00') : 'ongoing'}","${n}"`);
  }
  download(`job-summary-${ymd(new Date())}.csv`, lines.join('\r\n'));
  toast('CSV downloaded', 'ok');
}
