// ── Map tab: Esri imagery, borehole pins, GPS, search, add-pin ─────

import { $, $$, esc, on, toast, sheet, closeSheet, modalForm, haversineM, fmtDist, fmtFt, debounce } from './util.js';
import { DB } from './db.js';
import { S, activeBoreholes, newBorehole } from './store.js';
import { openWell } from './wells.js';

let map = null;
const markers = new Map();   // borehole id → L.marker
export let myPos = null;     // {lat, lng, accuracy}
let myMarker = null, myCircle = null;
let placing = null;          // callback armed for pin placement
let watchId = null;

const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 }; // continental US

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
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', tileOpts).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', tileOpts).addTo(map);

  DB.kvGet('mapView').then(v => {
    if (v) map.setView(v.center, v.zoom);
    else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    renderMarkers(); // regroup now that pixel distances exist
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
  // pads split into individual pins once zoom separates them
  map.on('zoomend', debounce(renderMarkers, 80));
  startGPS();
  wireControls();
  setTimeout(() => map.invalidateSize(), 50);
}

export function refreshMapSize() { if (map) setTimeout(() => map.invalidateSize(), 50); }

// ── Pins ───────────────────────────────────────────────────────────
function pinIcon(b) {
  return L.divIcon({
    className: 'pin-wrap',
    iconSize: [30, 40],
    iconAnchor: [15, 38],
    html: `
      <div class="pin">
        <svg viewBox="0 0 30 40" width="30" height="40">
          <path d="M15 1C7.8 1 2 6.9 2 14.2 2 24.5 15 38 15 38S28 24.5 28 14.2C28 6.9 22.2 1 15 1z"
                fill="var(--pin)" stroke="#00000055" stroke-width="1.5"/>
          <circle cx="15" cy="14" r="5.5" fill="#0b0f14"/>
        </svg>
        <span class="pin-label">${esc(b.name)}</span>
      </div>`,
  });
}

// Quick-look popup: name + key depths + a button into the full well
function popupHTML(b) {
  const row = (label, v) => v
    ? `<div class="pin-pop-row"><span>${label}</span><b>${esc(fmtFt(v))}</b></div>` : '';
  const rows = row('Roof level', b.roof_level)
    + row('Bottom of casing', b.casing_bottom)
    + row('Mine floor', b.mine_floor);
  return `<div class="pin-pop">
    <div class="pin-pop-name">${esc(b.name)}</div>
    ${rows || `<div class="pin-pop-empty">No well data yet</div>`}
    <button class="pin-pop-open" data-open="${b.id}">Open well ›</button>
  </div>`;
}

function markerSig(b) {
  return `${b.name}|${b.lat}|${b.lng}|${b.roof_level || ''}|${b.casing_bottom || ''}|${b.mine_floor || ''}`;
}

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
  // west → east so the list reads like the pad looks on the ground
  const sorted = [...group].sort((a, b) => a.lng - b.lng);
  return `<div class="pin-pop">
    <div class="pin-pop-name">${sorted.length} wells on this pad</div>
    <div class="pin-pop-order">west → east</div>
    ${sorted.map(b => `
      <button class="pad-row" data-open="${b.id}">
        <span>${esc(b.name)}</span><span class="pad-open">Open ›</span>
      </button>`).join('')}
  </div>`;
}

// Greedy pixel-space grouping: wells whose pins would collide at the
// current zoom (~44px) merge into one pad pin.
const CLUSTER_PX = 44;
function groupWells(list) {
  // no view yet (first paint) → no pixel math possible; render singles
  if (!map || !map._loaded) return list.map(b => [b]);
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
  return groups;
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
        existing.setPopupContent(single ? popupHTML(g[0]) : padPopupHTML(g));
        if (existing.isPopupOpen()) wirePopupBtn(existing.getPopup());
        existing._sig = sig;
      }
    } else {
      const m = L.marker([lat, lng], { icon: single ? pinIcon(g[0]) : padIcon(g) })
        .bindPopup(single ? popupHTML(g[0]) : padPopupHTML(g),
          { className: 'pin-popup', offset: [0, -34], autoPanPadding: [24, 90] })
        .addTo(map);
      m._sig = sig;
      markers.set(key, m);
    }
  }
  for (const [key, m] of markers) {
    if (!seen.has(key)) { m.remove(); markers.delete(key); }
  }
}

export function flyToWell(b, zoom = 17) {
  if (!map) return;
  map.flyTo([b.lat, b.lng], Math.max(map.getZoom(), zoom), { duration: 0.8 });
}

// ── GPS ────────────────────────────────────────────────────────────
function startGPS() {
  if (!('geolocation' in navigator) || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(
    pos => {
      myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      drawMyPos();
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
    if (myPos) map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 18));
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
  const infoBtn = $('#map-info');
  if (infoBtn) infoBtn.onclick = () => $('#map-info-panel').classList.toggle('open');

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
        if (b) {
          // fly there and show the quick-look popup (not the full sheet).
          // timeout (not 'moveend') so it still opens when the map is
          // already centered on that well and flyTo is a no-op.
          flyToWell(b);
          setTimeout(() => {
            // the well may be merged into a pad pin at this zoom
            const m = markers.get(b.id) ||
              [...markers.entries()].find(([k]) => k.startsWith('pad:') && k.includes(b.id))?.[1];
            if (m) m.openPopup();
          }, 850);
        }
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
}

// LeaseSight-style placement: pin fixed center-screen, map drags under it.
// startLatLng (optional) centers the map there first.
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
    title: 'New borehole',
    fields: [{ name: 'name', label: 'Borehole name', placeholder: 'e.g. BH-14', required: true }],
    okText: 'Add pin',
  });
  if (!res || !res.name.trim()) return;
  const b = await newBorehole(res.name.trim(), latlng.lat, latlng.lng);
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
