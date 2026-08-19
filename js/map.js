// ── Map tab: Esri imagery, borehole pins, GPS, search, add-pin ─────

import { $, $$, esc, on, toast, sheet, closeSheet, modalForm, confirmDlg, haversineM, fmtDist, fmtFt, debounce } from './util.js';
import { DB } from './db.js';
import { S, activeBoreholes, newBorehole, activeDrawings, newDrawing, isOwnerAccount, softDelete } from './store.js';
import { openWell } from './wells.js';

let map = null;
const markers = new Map();   // borehole id → L.marker
export let myPos = null;     // {lat, lng, accuracy}
let myMarker = null, myCircle = null;
let placing = null;          // callback armed for pin placement
let watchId = null;

const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 }; // continental US

// ── Basemap sources (Esri = sharp, USGS = often newer) ─────────────
const BASEMAPS = {};
let baseKey = null;
function setBasemap(key) {
  if (!BASEMAPS[key] || baseKey === key) return;
  if (baseKey) map.removeLayer(BASEMAPS[baseKey]);
  baseKey = key;
  BASEMAPS[key].addTo(map);
  DB.kvSet('basemap', key);
}

export function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }

  map = L.map('map', {
    zoomControl: false,
    attributionControl: false, // replaced by our own "i" button
    tap: false,
    zoomSnap: 0,               // fully continuous pinch-zoom (no step snapping)
    wheelPxPerZoomLevel: 90,
    zoomAnimationThreshold: 4,
  });

  // crossOrigin lets the service worker verify tile responses before
  // caching them for offline use (no opaque-response quota padding).
  // keepBuffer/updateWhenZooming tuned so pan & pinch feel responsive.
  const tileOpts = {
    maxZoom: 21, maxNativeZoom: 19, crossOrigin: true,
    // updateWhenIdle:true → don't fetch tiles mid-gesture, so the pan/pinch
    // itself stays smooth; tiles fill in the moment you let go
    keepBuffer: 3, updateWhenZooming: false, updateWhenIdle: true,
  };
  // Two imagery sources (layers button flips them): Esri is the sharpest
  // zoomed way in; USGS (NAIP flyovers) is often YEARS newer over rural
  // ground but tops out at z16 native, so it goes soft up close.
  BASEMAPS.esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { ...tileOpts, zIndex: 1 });
  BASEMAPS.usgs = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', { ...tileOpts, maxNativeZoom: 16, zIndex: 1 });
  // zIndex keeps the place-name overlay above whichever base is active
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { ...tileOpts, zIndex: 2 }).addTo(map);
  setBasemap('esri');
  DB.kvGet('basemap').then(k => { if (k === 'usgs') setBasemap('usgs'); });

  DB.kvGet('mapView').then(v => {
    if (v) map.setView(v.center, v.zoom);
    else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    renderMarkers(); // regroup now that pixel distances exist
    renderDrawings(); // vector layers need a view before they can project
  });
  map.on('moveend', () => {
    const c = map.getCenter();
    DB.kvSet('mapView', { center: [c.lat, c.lng], zoom: map.getZoom() });
  });

  // While placing: the pin floats center-screen and the map moves under
  // it (finger never covers the pin). A tap jumps the map there.
  map.on('click', e => {
    if (placing) map.panTo(e.latlng);
  });
  map.on('move', updatePlacingCoords);

  // wire the "Open well" button inside a pin's popup
  map.on('popupopen', e => wirePopupBtn(e.popup));

  renderMarkers();
  // debounced: a bulk sync merge fires one event per row — render once
  on('data:boreholes', debounce(renderMarkers, 150));
  on('data:drawings', debounce(renderDrawings, 100));
  // pads split into individual pins once zoom separates them
  map.on('zoomend', debounce(renderMarkers, 80));
  on('owner', () => { setDrawBtn(); renderDrawings(); });
  on('profile', setDrawBtn);
  // another tab asks the map to show a well (small delay lets the tab
  // switch + invalidateSize settle before the flyTo)
  on('map:show-well', id => {
    const b = activeBoreholes().find(x => x.id === id);
    if (b) setTimeout(() => revealWell(b), 120);
  });
  startGPS();
  wireControls();
  setDrawBtn();
  setTimeout(() => map.invalidateSize(), 50);
}

export function refreshMapSize() {
  if (map) setTimeout(() => { map.invalidateSize(); declutterLabels(); }, 50);
}

// ── Pins ───────────────────────────────────────────────────────────
const isWellPin = b => (b.kind || 'well') === 'well';

function pinIcon(b) {
  // landmarks (school, office, gate…) = blue pin with a star
  if (!isWellPin(b)) {
    return L.divIcon({
      className: 'pin-wrap',
      iconSize: [30, 40],
      iconAnchor: [15, 38],
      html: `
        <div class="pin">
          <svg viewBox="0 0 30 40" width="30" height="40">
            <path d="M15 1C7.8 1 2 6.9 2 14.2 2 24.5 15 38 15 38S28 24.5 28 14.2C28 6.9 22.2 1 15 1z"
                  fill="#4da3ff" stroke="#00000055" stroke-width="1.5"/>
            <path d="M15 8.5l1.8 3.7 4.1.6-3 2.9.7 4.1-3.6-1.9-3.6 1.9.7-4.1-3-2.9 4.1-.6z" fill="#0b0f14"/>
          </svg>
          <span class="pin-label">${esc(b.name)}</span>
        </div>`,
    });
  }
  // clear/obstructed (owner-set) colors the pin body green/red for the
  // whole crew; seals set keeps its check emblem on top of whichever color
  const statusFill = b.status === 'clear' ? '#35d073'
    : b.status === 'obstructed' ? '#ff5252'
    : b.status === 'partial' ? '#ffe14d' : null;
  const body = b.seals_set
    ? `<path d="M15 1C7.8 1 2 6.9 2 14.2 2 24.5 15 38 15 38S28 24.5 28 14.2C28 6.9 22.2 1 15 1z"
             fill="${statusFill || '#8b98a5'}" stroke="#00000055" stroke-width="1.5"/>
       <circle cx="15" cy="14" r="6" fill="#0b0f14"/>
       <path d="M11.5 14.2l2.4 2.4 4.6-4.8" fill="none" stroke="#8ff0b4" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M15 1C7.8 1 2 6.9 2 14.2 2 24.5 15 38 15 38S28 24.5 28 14.2C28 6.9 22.2 1 15 1z"
             fill="${statusFill || 'var(--pin)'}" stroke="#00000055" stroke-width="1.5"/>
       <circle cx="15" cy="14" r="5.5" fill="#0b0f14"/>`;
  return L.divIcon({
    className: 'pin-wrap',
    iconSize: [30, 40],
    iconAnchor: [15, 38],
    html: `
      <div class="pin">
        <svg viewBox="0 0 30 40" width="30" height="40">${body}</svg>
        <span class="pin-label">${esc(b.name)}</span>
      </div>`,
  });
}

// Quick-look popup: name + key depths + a button into the full well
function popupHTML(b) {
  if (!isWellPin(b)) {
    return `<div class="pin-pop">
      <div class="pin-pop-name">${esc(b.name)}</div>
      <div class="pin-pop-empty">Landmark</div>
      <button class="pin-pop-open" data-open="${b.id}">Open ›</button>
    </div>`;
  }
  const row = (label, v) => v
    ? `<div class="pin-pop-row"><span>${label}</span><b>${esc(fmtFt(v))}</b></div>` : '';
  const rows = row('Roof level', b.roof_level)
    + row('Bottom of casing', b.casing_bottom)
    + row('Mine floor', b.mine_floor);
  return `<div class="pin-pop">
    <div class="pin-pop-name">${esc(b.name)}${b.seals_set ? ' <span class="seals-tag">✓ seals set</span>' : ''}${statusTag(b)}</div>
    ${rows || `<div class="pin-pop-empty">No well data yet</div>`}
    <button class="pin-pop-open" data-open="${b.id}">Open well ›</button>
  </div>`;
}

function markerSig(b) {
  return `${b.name}|${b.kind || 'well'}|${b.lat}|${b.lng}|${b.seals_set ? 1 : 0}|${b.status || ''}|${b.roof_level || ''}|${b.casing_bottom || ''}|${b.mine_floor || ''}`;
}
const statusTag = b => (b.status
  ? ` <span class="status-tag ${b.status}">● ${b.status === 'partial' ? 'partially obstructed' : b.status}</span>` : '');

// (re)bind every "Open well" button in a popup (pad popups have several)
function wirePopupBtn(popup) {
  const node = popup && popup._contentNode;
  if (!node) return;
  node.querySelectorAll('[data-open]').forEach(btn => {
    btn.onclick = () => { map.closePopup(); openWell(btn.dataset.open); };
  });
}

// Pad pin: wells drilled ~20ft apart share one pin until zoom separates
// them. Tapping it lists the wells in line order (west → east).
function padIcon(group) {
  return L.divIcon({
    className: 'pin-wrap',
    iconSize: [34, 44],
    iconAnchor: [17, 42],
    html: `
      <div class="pin">
        <svg viewBox="0 0 30 40" width="34" height="44">
          <path d="M15 1C7.8 1 2 6.9 2 14.2 2 24.5 15 38 15 38S28 24.5 28 14.2C28 6.9 22.2 1 15 1z"
                fill="var(--pin)" stroke="#00000055" stroke-width="1.5"/>
          <circle cx="15" cy="14" r="7.5" fill="#0b0f14"/>
          <text x="15" y="18" text-anchor="middle" fill="var(--pin)"
                font-size="11" font-weight="800" font-family="sans-serif">${group.length}</text>
        </svg>
        <span class="pin-label">${esc(group.length)} wells</span>
      </div>`,
  });
}

function padPopupHTML(group) {
  const sorted = [...group].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }));
  return `<div class="pin-pop">
    <div class="pin-pop-name">${sorted.length} wells on this pad</div>
    ${sorted.map(b => `
      <button class="pad-row" data-open="${b.id}">
        <span>${esc(b.name)}${b.seals_set ? ' <span class="seals-tag">✓</span>' : ''}${statusTag(b)}</span>
        <span class="pad-open">Open ›</span>
      </button>`).join('')}
  </div>`;
}

// Greedy pixel-space grouping: wells whose pins would collide at the
// current zoom (~44px) merge into one pad pin.
const CLUSTER_PX = 44;
function groupWells(list) {
  // no view yet (first paint) → no pixel math possible; render singles
  if (!map || !map._loaded) return list.map(b => [b]);
  // landmarks never merge into pads
  const places = list.filter(b => !isWellPin(b)).map(b => [b]);
  list = list.filter(isWellPin);
  const pts = list.map(b => ({ b, p: map.latLngToLayerPoint([b.lat, b.lng]) }));
  const groups = [];
  const used = new Set();
  for (let i = 0; i < pts.length; i++) {
    if (used.has(i)) continue;
    const g = [pts[i].b];
    used.add(i);
    for (let j = i + 1; j < pts.length; j++) {
      if (used.has(j)) continue;
      // must collide on screen AND actually be the same pad (~160ft) —
      // zoomed way out, wells miles apart just overlap like before
      if (pts[i].p.distanceTo(pts[j].p) < CLUSTER_PX &&
          haversineM(pts[i].b, pts[j].b) < 50) { g.push(pts[j].b); used.add(j); }
    }
    groups.push(g);
  }
  return [...groups, ...places];
}

const POPUP_OPTS = { className: 'pin-popup', offset: [0, -34], autoPanPadding: [24, 90] };
// past this zoom there's no more room to expand — fall back to the list
const PAD_MAX_ZOOM = 20.5;
// single pins: tapped from way out, fly to a comfortable site view first
const SINGLE_ZOOM_MIN = 15;
const SINGLE_ZOOM_TO = 16;

// Cluster tap = zoom in to expand (IBE-style). Only when we're already
// maxed out and the wells still can't separate does the pick-list open.
function onPadClick(m) {
  const bounds = L.latLngBounds(m._group.map(w => [w.lat, w.lng]));
  if (map.getZoom() < PAD_MAX_ZOOM) {
    map.flyToBounds(bounds.pad(0.4), { maxZoom: 21, duration: 0.6 });
  } else {
    openPadList(m);
  }
}
function openPadList(m) {
  L.popup(POPUP_OPTS).setLatLng(m.getLatLng()).setContent(padPopupHTML(m._group)).openOn(map);
}

function onSingleClick(m) {
  if (map.getZoom() < SINGLE_ZOOM_MIN) {
    map.flyTo(m.getLatLng(), SINGLE_ZOOM_TO, { duration: 0.6 });
  } else {
    openSinglePopup(m);
  }
}
function openSinglePopup(m) {
  L.popup(POPUP_OPTS).setLatLng(m.getLatLng()).setContent(popupHTML(m._well)).openOn(map);
}

function renderMarkers() {
  if (!map) return;
  const groups = groupWells(activeBoreholes());
  const seen = new Set();
  for (const g of groups) {
    const single = g.length === 1;
    const key = single ? g[0].id : 'pad:' + g.map(b => b.id).sort().join(',');
    seen.add(key);
    const lat = g.reduce((s, b) => s + b.lat, 0) / g.length;
    const lng = g.reduce((s, b) => s + b.lng, 0) / g.length;
    const sig = g.map(markerSig).join('~');
    const existing = markers.get(key);
    if (existing) {
      if (existing._sig !== sig) {
        existing.setLatLng([lat, lng]);
        existing.setIcon(single ? pinIcon(g[0]) : padIcon(g));
        if (single) existing._well = g[0]; else existing._group = g;
        existing._sig = sig;
      }
    } else {
      const m = L.marker([lat, lng], { icon: single ? pinIcon(g[0]) : padIcon(g) }).addTo(map);
      if (single) {
        m._well = g[0];
        m.on('click', () => onSingleClick(m));
      } else {
        m._group = g;
        m.on('click', () => onPadClick(m));
      }
      m._sig = sig;
      markers.set(key, m);
    }
  }
  for (const [key, m] of markers) {
    if (!seen.has(key)) { m.remove(); markers.delete(key); }
  }
  declutterLabels();
}

// Zoomed out, dozens of labels pile into an unreadable heap — hide the
// ones that would overlap and let them reappear as zoom spreads the pins
// apart. The pin itself always shows; tapping it always names it.
function declutterLabels() {
  if (!map || !map._loaded) return;
  // another tab is showing → the map is display:none and every label
  // measures 0×0 at (0,0), which would "collide" them all into hiding.
  // refreshMapSize re-runs this when the map tab comes back.
  if (!map.getContainer().getBoundingClientRect().width) return;
  const items = [];
  for (const m of markers.values()) {
    const el = m.getElement();
    const label = el && el.querySelector('.pin-label');
    if (label) items.push({ label, pad: Boolean(m._group), name: m._well ? m._well.name : '' });
  }
  // stable priority (pads first, then A→Z) so the same names win every
  // time instead of flickering between renders
  items.sort((a, b) => (b.pad - a.pad) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const kept = [];
  for (const it of items) {
    // visibility:hidden keeps layout, so hidden labels still measure
    const r = it.label.getBoundingClientRect();
    const clash = kept.some(k =>
      r.left < k.right + 3 && r.right > k.left - 3 &&
      r.top < k.bottom + 2 && r.bottom > k.top - 2);
    it.label.classList.toggle('label-off', clash);
    if (!clash) kept.push(r);
  }
}

export function flyToWell(b, zoom = 17) {
  if (!map) return;
  map.flyTo([b.lat, b.lng], Math.max(map.getZoom(), zoom), { duration: 0.8 });
}

// Fly to a well and pop its quick-look card — used by search results and
// the "map:show-well" event (e.g. the Map button on a video card).
// timeout (not 'moveend') so it still opens when the map is already
// centered on that well and flyTo is a no-op.
function revealWell(b) {
  if (!map) return;
  flyToWell(b);
  setTimeout(() => {
    // the well may be merged into a pad pin at this zoom
    const m = markers.get(b.id) ||
      [...markers.entries()].find(([k]) => k.startsWith('pad:') && k.includes(b.id))?.[1];
    if (!m) return;
    if (m._group) openPadList(m); // show the list so they can pick it
    else openSinglePopup(m);
  }, 850);
}

// ── Freehand drawing (owner only) ──────────────────────────────────
// One finger sketches a line straight onto the imagery; strokes sync to
// every device like pins do. Only the owner's account gets the button
// (and only he can erase — tap a line outside draw mode).
let drawLayer = null;
let drawMode = false;
let drawColor = '#ffd23f';
let stroke = null;          // in-progress line while the finger is down
let sessionStrokes = [];    // ids drawn since entering draw mode (Undo order)

function setDrawBtn() {
  const btn = $('#btn-draw');
  if (btn) btn.style.display = isOwnerAccount() ? '' : 'none';
}

function renderDrawings() {
  if (!map || !map._loaded) return;
  if (!drawLayer) drawLayer = L.layerGroup().addTo(map);
  drawLayer.clearLayers();
  for (const d of activeDrawings()) {
    if (!Array.isArray(d.points) || d.points.length < 2) continue;
    drawLayer.addLayer(L.polyline(d.points, {
      color: d.color || '#ffd23f', weight: d.width || 4,
      opacity: 0.95, interactive: false,
    }));
    if (isOwnerAccount()) {
      // fat invisible twin = finger-sized tap target for erasing
      const hit = L.polyline(d.points, { color: '#000', weight: 24, opacity: 0.001 });
      hit.on('click', e => {
        if (drawMode || placing) return;
        L.DomEvent.stop(e);
        confirmDlg('Erase this drawing?', { okText: 'Erase', danger: true, title: 'Erase drawing' })
          .then(ok => { if (ok) softDelete('drawings', d); });
      });
      drawLayer.addLayer(hit);
    }
  }
}

function enterDraw() {
  if (drawMode || !map) return;
  stopPlacing();
  map.closePopup();
  drawMode = true;
  sessionStrokes = [];
  $('#view-map').classList.add('drawing');
  map.dragging.disable();
  const c = map.getContainer();
  c.addEventListener('pointerdown', onDrawDown);
  c.addEventListener('pointermove', onDrawMove);
  // up/cancel on window: a finger lifted off the edge of the map still ends the stroke
  window.addEventListener('pointerup', onDrawUp);
  window.addEventListener('pointercancel', onDrawCancel);
  c.addEventListener('touchstart', onDrawTouch, { passive: true });
}

function exitDraw() {
  if (!drawMode) return;
  drawMode = false;
  if (stroke) { stroke.line.remove(); stroke = null; }
  $('#view-map').classList.remove('drawing');
  map.dragging.enable();
  const c = map.getContainer();
  c.removeEventListener('pointerdown', onDrawDown);
  c.removeEventListener('pointermove', onDrawMove);
  window.removeEventListener('pointerup', onDrawUp);
  window.removeEventListener('pointercancel', onDrawCancel);
  c.removeEventListener('touchstart', onDrawTouch);
}

function onDrawDown(e) {
  if (!drawMode || stroke || e.button > 0) return;
  const p = map.mouseEventToContainerPoint(e);
  stroke = {
    id: e.pointerId, px: p, pts: [map.containerPointToLatLng(p)],
    line: L.polyline([], { color: drawColor, weight: 4, opacity: 0.95, interactive: false }).addTo(map),
  };
  e.preventDefault();
}

function onDrawMove(e) {
  if (!stroke || e.pointerId !== stroke.id) return;
  const p = map.mouseEventToContainerPoint(e);
  if (p.distanceTo(stroke.px) < 3) return; // ~3px between points keeps strokes light
  stroke.px = p;
  stroke.pts.push(map.containerPointToLatLng(p));
  stroke.line.setLatLngs(stroke.pts);
  e.preventDefault();
}

async function onDrawUp(e) {
  if (!stroke || e.pointerId !== stroke.id) return;
  const s = stroke;
  stroke = null;
  s.line.remove();
  if (s.pts.length < 2) return; // a tap, not a stroke
  const pts = s.pts.map(ll => [+ll.lat.toFixed(6), +ll.lng.toFixed(6)]);
  const d = await newDrawing(pts, drawColor);
  sessionStrokes.push(d.id);
  renderDrawings();
}

function onDrawCancel(e) {
  if (stroke && e.pointerId === stroke.id) { stroke.line.remove(); stroke = null; }
}

// second finger = pinch-zoom, not a line — drop the half-drawn stroke
function onDrawTouch(e) {
  if (e.touches.length > 1 && stroke) { stroke.line.remove(); stroke = null; }
}

// ── Follow-me road recording (owner only) ──────────────────────────
// Start it, drive the road, hit Save — the GPS breadcrumb trail gets
// simplified + smoothed into one clean line and saved like any stroke.
let roadRec = null; // {pts, dist, line, wake}

async function startRoadRec() {
  if (roadRec) return;
  if (!('geolocation' in navigator)) { toast('No GPS on this device', 'warn'); return; }
  exitDraw();
  startGPS();
  roadRec = {
    pts: [], dist: 0, wake: null,
    line: L.polyline([], { color: drawColor, weight: 4, opacity: 0.9, dashArray: '6 8', interactive: false }).addTo(map),
  };
  $('#view-map').classList.add('roadrec');
  updateRoadRecMsg();
  if (myPos) roadRecAdd(myPos); // seed with the current fix
  acquireWake();
  toast("Drive the road — I'll trace it. Keep the app open and the screen on.", 'ok');
}

// keep the screen awake while recording (best-effort; iOS 16.4+)
async function acquireWake() {
  if (!roadRec || !navigator.wakeLock) return;
  try {
    roadRec.wake = await navigator.wakeLock.request('screen');
    roadRec.wake.addEventListener('release', () => { if (roadRec) roadRec.wake = null; });
  } catch { /* screen will dim on its own schedule */ }
}

function roadRecAdd(pos) {
  if (!roadRec) return;
  if (pos.accuracy > 40) return; // junk fix — wait for a clean one
  const last = roadRec.pts[roadRec.pts.length - 1];
  if (last) {
    const d = haversineM(last, pos);
    // ignore GPS jitter while sitting still; record every ~6m+ of travel
    if (d < Math.max(6, pos.accuracy / 4)) return;
    roadRec.dist += d;
  }
  roadRec.pts.push({ lat: pos.lat, lng: pos.lng });
  roadRec.line.setLatLngs(roadRec.pts);
  updateRoadRecMsg();
}

function updateRoadRecMsg() {
  const el = $('#roadrec-msg');
  if (el && roadRec) el.textContent = `Recording road · ${fmtDist(roadRec.dist)}`;
}

async function stopRoadRec(saveIt) {
  const r = roadRec;
  if (!r) return;
  roadRec = null;
  r.line.remove();
  try { r.wake && r.wake.release(); } catch { /* already gone */ }
  $('#view-map').classList.remove('roadrec');
  if (!saveIt) { toast('Recording discarded', 'ok'); return; }
  if (r.pts.length < 2) { toast('Not enough movement to make a road yet', 'warn'); return; }
  // straighten the jitter out, then round the corners
  const pts = chaikin(simplifyDP(r.pts, 8), 2)
    .map(p => [+p.lat.toFixed(6), +p.lng.toFixed(6)]);
  await newDrawing(pts, drawColor);
  renderDrawings();
  toast(`Road saved — ${fmtDist(r.dist)}`, 'ok');
}

// Douglas-Peucker in meters (equirectangular is plenty at road scale)
function simplifyDP(pts, tolM) {
  if (pts.length < 3) return pts;
  const lat0 = (pts[0].lat * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0), my = 110540;
  const P = pts.map(p => ({ x: (p.lng - pts[0].lng) * mx, y: (p.lat - pts[0].lat) * my }));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const ax = P[a].x, ay = P[a].y;
    const dx = P[b].x - ax, dy = P[b].y - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((P[i].x - ax) * dx + (P[i].y - ay) * dy) / len2));
      const ex = ax + t * dx - P[i].x, ey = ay + t * dy - P[i].y;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (Math.sqrt(maxD) > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Chaikin corner-cutting: each pass replaces corners with two gentler ones
function chaikin(pts, iters) {
  for (let k = 0; k < iters && pts.length > 2; k++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({ lat: a.lat * 0.75 + b.lat * 0.25, lng: a.lng * 0.75 + b.lng * 0.25 });
      out.push({ lat: a.lat * 0.25 + b.lat * 0.75, lng: a.lng * 0.25 + b.lng * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

async function undoDrawing() {
  // only this session's strokes — a stray Undo tap must never silently
  // eat a line sketched days ago (tap the line itself to erase those)
  let d = null;
  while (sessionStrokes.length && !d) {
    const id = sessionStrokes.pop();
    d = activeDrawings().find(x => x.id === id) || null;
  }
  if (!d) { toast('Nothing new to undo — tap a line to erase it', 'warn'); return; }
  await softDelete('drawings', d);
  renderDrawings();
}

// ── GPS ────────────────────────────────────────────────────────────
function startGPS() {
  if (!('geolocation' in navigator) || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(
    pos => {
      myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      drawMyPos();
      roadRecAdd(myPos); // no-op unless a road recording is running
    },
    err => {
      // A denied watch never resumes; clear it so the locate button can
      // re-arm after the user re-allows location. TIMEOUT/UNAVAILABLE are
      // per-attempt on a watch — leave those running.
      if (err.code === err.PERMISSION_DENIED) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function drawMyPos() {
  if (!map || !myPos) return;
  const ll = [myPos.lat, myPos.lng];
  if (!myMarker) {
    myMarker = L.marker(ll, {
      interactive: false,
      zIndexOffset: -1000, // sit BELOW borehole pins so a well you're on stays visible
      icon: L.divIcon({ className: 'me-wrap', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="me-dot"></div>' }),
    }).addTo(map);
    myCircle = L.circle(ll, { radius: myPos.accuracy, className: 'me-acc', interactive: false }).addTo(map);
  } else {
    myMarker.setLatLng(ll);
    myCircle.setLatLng(ll).setRadius(myPos.accuracy);
  }
}

// ── Controls: locate, add pin, search, map info ────────────────────
function wireControls() {
  $('#btn-locate').onclick = () => {
    if (myPos) {
      map.flyTo([myPos.lat, myPos.lng], Math.max(map.getZoom(), 16), { duration: 0.7 });
      warnIfCoarse();
    } else {
      toast('Waiting for GPS… make sure location is allowed', 'warn');
      startGPS();
    }
  };

  $('#btn-add-pin').onclick = () => {
    stopPlacing(); // cancel any in-progress placement before re-entering
    sheet(`
      <h3>Add borehole</h3>
      <button class="btn primary big" id="add-here">${icon('crosshair')} Start at my location</button>
      <button class="btn big" id="add-tap">${icon('map')} Place on the map</button>
    `);
    $('#add-here').onclick = () => {
      if (!myPos) { toast('No GPS fix yet — use "Place on the map" instead', 'warn'); return; }
      closeSheet();
      armPlacing(latlng => createAt(latlng), 'Drag the map under the pin', [myPos.lat, myPos.lng]);
    };
    $('#add-tap').onclick = () => {
      closeSheet();
      armPlacing(latlng => createAt(latlng), 'Drag the map under the pin');
    };
  };

  $('#placing-gps').onclick = () => {
    if (!placing) return;
    if (myPos) { map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 18)); warnIfCoarse(); }
    else { toast('Waiting for GPS… make sure location is allowed', 'warn'); startGPS(); }
  };

  $('#placing-confirm').onclick = () => {
    if (!placing) return;
    const cb = placing;
    const ll = map.getCenter();
    stopPlacing();
    cb(ll);
  };

  // Map info ("i") — keeps the Esri credit off the map until tapped
  // (key and info share the anchor spot above the "i", so opening one
  // closes the other)
  const infoBtn = $('#map-info');
  if (infoBtn) infoBtn.onclick = () => {
    $('#map-key-panel').classList.remove('open');
    $('#map-info-panel').classList.toggle('open');
  };
  const keyBtn = $('#map-key');
  if (keyBtn) keyBtn.onclick = () => {
    $('#map-info-panel').classList.remove('open');
    $('#map-key-panel').classList.toggle('open');
  };

  // Search — opens the full well list on focus, filters as you type
  const input = $('#search-input');
  const results = $('#search-results');
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const list = activeBoreholes()
      .map(b => ({ b, d: myPos ? haversineM(myPos, b) : null }))
      .filter(x => !q || x.b.name.toLowerCase().includes(q))
      .sort((a, z) => (a.d ?? 1e12) - (z.d ?? 1e12));
    if (!list.length) {
      results.innerHTML = `<div class="search-empty">${q ? 'No boreholes match' : 'No boreholes yet — add one with the + button'}</div>`;
      return;
    }
    results.innerHTML = list.map(({ b, d }) => `
      <button class="search-row" data-id="${b.id}">
        <span class="search-name">${esc(b.name)}</span>
        <span class="search-meta">${d != null ? fmtDist(d) : ''}</span>
      </button>`).join('');
    $$('.search-row', results).forEach(el => {
      el.onclick = () => {
        const b = activeBoreholes().find(x => x.id === el.dataset.id);
        hideSearch();
        if (b) revealWell(b);
      };
    });
  };
  input.oninput = debounce(render, 100);
  input.onfocus = () => { $('#search-panel').classList.add('open'); render(); };
  $('#search-close').onclick = hideSearch;
  // dismissing the keyboard closes the well list (delay lets a result tap land)
  input.onblur = () => setTimeout(() => {
    if (document.activeElement !== input) hideSearch();
  }, 200);
  function hideSearch() {
    $('#search-panel').classList.remove('open');
    input.value = '';
    input.blur();
  }

  $('#placing-cancel').onclick = stopPlacing;

  // Imagery source flip (everyone): Esri detail ↔ USGS recency
  $('#btn-layers').onclick = () => {
    const next = baseKey === 'usgs' ? 'esri' : 'usgs';
    setBasemap(next);
    toast(next === 'usgs'
      ? 'USGS imagery — usually a newer flyover, but softer zoomed way in'
      : 'Esri imagery — sharpest close-up detail', 'ok');
  };

  // Draw mode (owner only — the button stays hidden for everyone else)
  $('#btn-draw').onclick = enterDraw;
  $('#draw-done').onclick = exitDraw;
  $('#draw-follow').onclick = startRoadRec;
  $('#roadrec-save').onclick = () => stopRoadRec(true);
  $('#roadrec-cancel').onclick = async () => {
    // a whole drive could be riding on this — ask before throwing it out
    if (await confirmDlg('Throw away this road recording?', { okText: 'Discard', danger: true })) {
      stopRoadRec(false);
    }
  };
  // wake lock drops whenever the app is backgrounded — grab it again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && roadRec && !roadRec.wake) acquireWake();
  });
  // leaving the Map tab ends draw mode (discarding any half stroke) so
  // the map never sits hidden with dragging off and listeners live
  $$('.tab-btn').forEach(b => {
    if (b.dataset.tab !== 'map') b.addEventListener('click', exitDraw);
  });
  $('#draw-undo').onclick = undoDrawing;
  $$('.draw-color').forEach(b => {
    b.onclick = () => {
      drawColor = b.dataset.color;
      $$('.draw-color').forEach(x => x.classList.toggle('on', x === b));
    };
  });
}

// LeaseSight-style placement: pin fixed center-screen, map drags under it.
// startLatLng (optional) centers the map there first.
// Computers have no GPS — the browser guesses from WiFi/IP and can be
// miles off. Say so instead of letting the blue dot lie quietly.
function warnIfCoarse() {
  if (myPos && myPos.accuracy > 2000) {
    toast(`Location is approximate on this device (±${fmtDist(myPos.accuracy)}) — use your phone in the field`, 'warn');
  }
}

export function armPlacing(cb, msg, startLatLng) {
  stopPlacing(); // reset any earlier attempt
  placing = cb;
  $('#placing-msg').textContent = msg;
  $('#view-map').classList.add('placing');
  if (startLatLng) map.setView(startLatLng, Math.max(map.getZoom(), 18));
  updatePlacingCoords();
}

function updatePlacingCoords() {
  if (!placing || !map) return;
  const c = map.getCenter();
  $('#placing-coords').textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
}

function stopPlacing() {
  placing = null;
  $('#view-map').classList.remove('placing');
}

async function createAt(latlng) {
  const res = await modalForm({
    title: 'New pin',
    fields: [
      { name: 'kind', label: 'What is it?', type: 'select', value: 'well', options: [
        { value: 'well', label: 'Borehole' },
        { value: 'place', label: 'Landmark (school, office, gate…)' },
      ] },
      { name: 'name', label: 'Name', placeholder: 'e.g. BH-14 or School', required: true },
    ],
    okText: 'Add pin',
  });
  if (!res || !res.name.trim()) return;
  const b = await newBorehole(res.name.trim(), latlng.lat, latlng.lng, res.kind || 'well');
  toast(`Added ${b.name}`, 'ok');
  flyToWell(b);
  openWell(b.id);
}

function icon(name) {
  const paths = {
    crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  };
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
