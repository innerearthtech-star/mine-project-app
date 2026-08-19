// ── Well report: print-ready depth sheet ───────────────────────────
// A clean white page — just the wells and their depths (roof level,
// bottom of casing, mine floor). Print / Save as PDF from the browser;
// Close returns to the app untouched.

import { $, esc, toast, fmtDate, fmtFt } from './util.js';
import { activeBoreholes, isWell, projectName } from './store.js';

export function openWellReport() {
  const wells = activeBoreholes().filter(isWell);
  if (!wells.length) { toast('No boreholes yet', 'warn'); return; }

  let view = $('#report-view');
  if (view) view.remove();
  view = document.createElement('div');
  view.id = 'report-view';
  const today = fmtDate(new Date());
  view.innerHTML = `
    <div class="rep-actions">
      <button class="btn small ghost" id="rep-close">✕ Close</button>
      <span class="rep-actions-spacer"></span>
      <button class="btn small primary" id="rep-print">🖨 Print / Save PDF</button>
    </div>
    <div class="rep-page">
      <div class="rep-head">
        <div>
          <div class="rep-title">${esc(projectName())} Project — Well Depths</div>
          <div class="rep-sub">${today} · ${wells.length} borehole${wells.length === 1 ? '' : 's'}</div>
        </div>
        <div class="rep-brand">Inner Earth Tech</div>
      </div>
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
      <div class="rep-foot">Generated ${today} · ${esc(projectName())} Project app by Inner Earth Tech</div>
    </div>`;
  document.body.appendChild(view);

  $('#rep-close', view).onclick = () => view.remove();
  $('#rep-print', view).onclick = () => window.print();
}
