// ── My Job tab (owner only): field hours, runs, night stays, export ─

import {
  $, $$, esc, on, toast, confirmDlg, modalForm, fmtDate, fmtTime, fmtDur,
  toLocalInput, daysBetween, ymd, download,
} from './util.js';
import {
  S, findRow, save, softDelete, activeBoreholes, activeRuns, activeShifts,
  activeJobs, openShift, currentJob, newRun, newShift, newJob, canUseJob,
  activeExpenses, newExpense,
} from './store.js';

let clockTimer = null;

export function initJob() {
  ['data:runs', 'data:shifts', 'data:jobs', 'data:expenses', 'data:boreholes', 'owner'].forEach(ev =>
    on(ev, () => { if (canUseJob()) renderJob(); }));
}

const fmtMoney = n => `$${(Number(n) || 0).toFixed(2)}`;

export function renderJob() {
  const root = $('#view-job .tab-body');
  if (!canUseJob()) { root.innerHTML = ''; return; }

  const runs = activeRuns();
  const shifts = activeShifts();
  const open = openShift();
  const job = currentJob();
  const totalMs = shifts.reduce((sum, s) =>
    sum + (s.end_ts ? (new Date(s.end_ts) - new Date(s.start_ts)) : 0), 0);
  const nights = nightsInfo(job);
  // under an hour, show minutes — "2m" beats a tile stuck on "0.0"
  const totalMin = Math.round(totalMs / 60000);
  const hoursStat = totalMin < 60
    ? { num: totalMin, label: 'field minutes' }
    : { num: (totalMs / 3600000).toFixed(1), label: 'field hours' };

  root.innerHTML = `
    <div class="stat-row">
      <div class="stat"><div class="stat-num">${runs.length}</div><div class="stat-label">runs</div></div>
      <div class="stat"><div class="stat-num">${hoursStat.num}</div><div class="stat-label">${hoursStat.label}</div></div>
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
        <div class="night-live">Night <b>${nights.active}</b> tonight · started ${fmtDate(job.night_start + 'T12:00')}</div>
        <div class="night-sub">Counting automatically — every night adds one until you finish.</div>
        <button class="btn big" id="btn-finish-job">Finish job — stop counting</button>
      ` : `
        <div class="night-sub">Tap when you check in for your first night — nights count automatically after that.</div>
        <button class="btn primary big" id="btn-start-job">Start night stays (first night tonight)</button>
      `}
      ${pastJobs()}
    </section>

    <section class="card">
      <div class="card-head"><h4>Expenses</h4>
        <button class="btn small primary" id="btn-add-expense">+ Add</button></div>
      ${renderExpenses()}
    </section>

    <section class="card">
      <h4>Export</h4>
      <button class="btn big" id="btn-export">Download job summary (CSV)</button>
    </section>
  `;

  wireJob(root, { open, job });
  startClock(open);
}

function renderExpenses() {
  const list = activeExpenses();
  if (!list.length) return `<div class="empty-hint">Nothing yet — fuel, supplies, whatever you need to bill back.</div>`;
  const total = list.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return `
    ${list.map(x => `
      <button class="row" data-expense="${x.id}">
        <span>${fmtDate(x.ts + 'T12:00')}</span>
        <span class="row-mid">${esc(x.label)}</span>
        <span class="row-strong">${fmtMoney(x.amount)}</span>
      </button>`).join('')}
    <div class="row static expense-total"><span></span><span class="row-mid">Total</span>
      <span class="row-strong">${fmtMoney(total)}</span></div>`;
}

function nightsInfo(job) {
  // total = every finished job's nights + the active job (night 1 is the
  // start date, tonight counts while the job is running)
  const done = activeJobs().filter(j => j.night_end);
  const finished = done.reduce((s, j) => s + daysBetween(j.night_start + 'T12:00', j.night_end + 'T12:00'), 0);
  const active = job ? daysBetween(job.night_start + 'T12:00', new Date()) + 1 : 0;
  return { count: finished + active, active };
}

const validDate = v => v && !isNaN(new Date(v));

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
  $('#btn-shift', root).onclick = async e => {
    e.target.disabled = true; // double-tap can't create two open shifts
    const live = openShift(); // re-check live, not the render-time snapshot
    if (live) {
      await save('shifts', { ...findRow('shifts', live.id), end_ts: new Date().toISOString() });
      toast(`Clocked out — ${fmtDur(Date.now() - new Date(live.start_ts))} in the field`, 'ok');
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
      ],
      deleteText: 'Delete day',
    });
    if (!res) return;
    if (res._delete) {
      if (await confirmDlg('Remove this day from your hours?', { okText: 'Delete', danger: true })) {
        await softDelete('shifts', s);
        toast('Day removed', 'ok');
      }
      return;
    }
    if (!validDate(res.start) || (res.end && !validDate(res.end))) {
      toast('Enter valid times', 'warn'); return;
    }
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
    if (!validDate(res.ts)) { toast('Enter a valid date & time', 'warn'); return; }
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
      ],
      deleteText: 'Delete run',
    });
    if (!res) return;
    if (res._delete) {
      if (await confirmDlg('Remove this run?', { okText: 'Delete', danger: true })) {
        await softDelete('runs', r);
        toast('Run removed', 'ok');
      }
      return;
    }
    if (!validDate(res.ts)) { toast('Enter a valid date & time', 'warn'); return; }
    await save('runs', { ...r, ts: new Date(res.ts).toISOString(), note: res.note || '' });
  });

  const startBtn = $('#btn-start-job', root);
  if (startBtn) startBtn.onclick = async () => {
    const res = await modalForm({
      title: 'Start night stays',
      fields: [{ name: 'date', label: 'First night', type: 'date', value: ymd(new Date()), required: true }],
      okText: 'Start counting',
    });
    if (!res) return;
    if (!validDate(res.date + 'T12:00')) { toast('Pick a valid date', 'warn'); return; }
    await newJob(res.date);
    toast('Night stays are counting automatically', 'ok');
  };

  const finishBtn = $('#btn-finish-job', root);
  if (finishBtn) finishBtn.onclick = async () => {
    const res = await modalForm({
      title: 'Finish job',
      fields: [{ name: 'date', label: 'Check-out morning', type: 'date', value: ymd(new Date()), required: true }],
      okText: 'Finish',
    });
    if (!res) return;
    if (!validDate(res.date + 'T12:00')) { toast('Pick a valid date', 'warn'); return; }
    const j = currentJob();
    if (!j) { toast('This job is already finished', 'warn'); return; }
    await save('jobs', { ...j, night_end: res.date });
    toast(`Job finished — ${daysBetween(j.night_start + 'T12:00', res.date + 'T12:00')} nights total`, 'ok');
  };

  $('#btn-add-expense', root).onclick = async () => {
    const res = await modalForm({
      title: 'Add expense',
      fields: [
        { name: 'label', label: 'What for', placeholder: 'e.g. fuel, supplies', required: true },
        { name: 'amount', label: 'Cost ($)', type: 'number', inputmode: 'decimal', placeholder: '0.00', required: true },
        { name: 'date', label: 'Date', type: 'date', value: ymd(new Date()), required: true },
      ],
      okText: 'Add',
    });
    if (!res) return;
    const amount = parseFloat(res.amount);
    if (!res.label.trim()) { toast('Say what it was for', 'warn'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { toast('Enter the cost as a number', 'warn'); return; }
    if (!validDate(res.date + 'T12:00')) { toast('Pick a valid date', 'warn'); return; }
    await newExpense(res.label.trim(), amount, res.date);
    toast(`${fmtMoney(amount)} — ${res.label.trim()}`, 'ok');
  };

  $$('[data-expense]', root).forEach(el => el.onclick = async () => {
    const x = findRow('expenses', el.dataset.expense);
    const res = await modalForm({
      title: 'Edit expense',
      fields: [
        { name: 'label', label: 'What for', value: x.label, required: true },
        { name: 'amount', label: 'Cost ($)', type: 'number', inputmode: 'decimal', value: x.amount, required: true },
        { name: 'date', label: 'Date', type: 'date', value: x.ts, required: true },
      ],
      deleteText: 'Delete expense',
    });
    if (!res) return;
    if (res._delete) {
      if (await confirmDlg('Remove this expense?', { okText: 'Delete', danger: true })) {
        await softDelete('expenses', x);
        toast('Expense removed', 'ok');
      }
      return;
    }
    const amount = parseFloat(res.amount);
    if (!res.label.trim() || !Number.isFinite(amount) || amount <= 0 || !validDate(res.date + 'T12:00')) {
      toast('Check the fields — cost must be a number', 'warn'); return;
    }
    await save('expenses', { ...x, label: res.label.trim(), amount, ts: res.date });
  });

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
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`; // CSV-safe cell
  const row = (...cells) => cells.map(q).join(',');
  const lines = [];
  const wellName = id => { const b = findRow('boreholes', id); return b ? b.name : 'Unknown'; };
  lines.push('RUNS');
  lines.push(row('Borehole', 'Date', 'Time', 'Note'));
  for (const r of activeRuns().slice().reverse()) {
    lines.push(row(wellName(r.borehole_id), fmtDate(r.ts), fmtTime(r.ts), r.note || ''));
  }
  lines.push('');
  lines.push('FIELD HOURS');
  lines.push(row('Date', 'Left hotel', 'Back at hotel', 'Hours'));
  for (const s of activeShifts().slice().reverse()) {
    const dur = s.end_ts ? ((new Date(s.end_ts) - new Date(s.start_ts)) / 3600000).toFixed(2) : '';
    lines.push(row(fmtDate(s.start_ts), fmtTime(s.start_ts), s.end_ts ? fmtTime(s.end_ts) : '', dur));
  }
  lines.push('');
  lines.push('EXPENSES');
  lines.push(row('Date', 'What for', 'Cost'));
  const exps = activeExpenses().slice().reverse();
  for (const x of exps) {
    lines.push(row(fmtDate(x.ts + 'T12:00'), x.label, (Number(x.amount) || 0).toFixed(2)));
  }
  if (exps.length) {
    lines.push(row('', 'TOTAL', exps.reduce((s, x) => s + (Number(x.amount) || 0), 0).toFixed(2)));
  }
  lines.push('');
  lines.push('NIGHT STAYS');
  lines.push(row('First night', 'Checked out', 'Nights'));
  for (const j of activeJobs()) {
    const n = j.night_end
      ? daysBetween(j.night_start + 'T12:00', j.night_end + 'T12:00')
      : daysBetween(j.night_start + 'T12:00', new Date()) + 1;
    lines.push(row(fmtDate(j.night_start + 'T12:00'), j.night_end ? fmtDate(j.night_end + 'T12:00') : 'ongoing', n));
  }
  download(`job-summary-${ymd(new Date())}.csv`, lines.join('\r\n'));
  toast('CSV downloaded', 'ok');
}
