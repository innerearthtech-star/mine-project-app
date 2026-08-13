// ── Map tab: Esri imagery, borehole pins, GPS, search, add-pin ─────

import { $, $$, esc, on, toast, sheet, closeSheet, modalForm, haversineM, fmtDist, fmtFt, debounce } from './util.js';
import { DB } from './db.js';
import { S, activeBoreholes, newBorehole } from './store.js';
import { openWell } from './wells.js';

let map = null;
const markers = new Map();   // borehole id → L.marker
export let myPos = null;     // {lat, lng, accuracy}
let myMarker = null, myCircle = null;
let placing = null;          // callback armed for "tap map to place"
let watchId = null;

const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 }; // continental US

export function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }

  map = L.map('map', {
    zoomControl: false,
    attributionControl: false, // replaced by our own "i" button
    tap: false,
    zoomSnap: 0.5,             // smoother pinch-zoom (lands on half levels)
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
  });

  // crossOrigin lets the service worker verify tile responses before
  // caching them for offline use (no opaque-response quota padding).
  // keepBuffer/updateWhenZooming tuned so pan & pinch feel responsive.
  const tileOpts = {
    maxZoom: 21, maxNativeZoom: 19, crossOrigin: true,
    keepBuffer: 4, updateWhenZooming: false, updateWhenIdle: false,
  };
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', tileOpts).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', tileOpts).addTo(map);

  DB.kvGet('mapView').then(v => {
    if (v) map.setView(v.center, v.zoom);
    else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  });
  map.on('moveend', () => {
    const c = map.getCenter();
    DB.kvSet('mapView', { center: [c.lat, c.lng], zoom: map.getZoom() });
  });

  map.on('click', e => {
    if (placing) {
      const cb = placing;
      stopPlacing();
      cb(e.latlng);
    }
  });

  // wire the "Open well" button inside a pin's popup
  map.on('popupopen', e => {
    const node = e.popup._contentNode;
    const btn = node && node.querySelector('[data-open]');
    if (btn) btn.onclick = () => { map.closePopup(); openWell(btn.dataset.open); };
  });

  renderMarkers();
  // debounced: a bulk sync merge fires one event per row — render once
  on('data:boreholes', debounce(renderMarkers, 150));
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
  const d = [];
  if (b.roof_level) d.push(`Roof <b>${esc(fmtFt(b.roof_level))}</b>`);
  if (b.casing_bottom) d.push(`Casing <b>${esc(fmtFt(b.casing_bottom))}</b>`);
  if (b.mine_floor) d.push(`Floor <b>${esc(fmtFt(b.mine_floor))}</b>`);
  return `<div class="pin-pop">
    <div class="pin-pop-name">${esc(b.name)}</div>
    ${d.length ? `<div class="pin-pop-depths">${d.join('<span class="dot-sep">·</span>')}</div>`
      : `<div class="pin-pop-empty">No well data yet</div>`}
    <button class="pin-pop-open" data-open="${b.id}">Open well ›</button>
  </div>`;
}

function markerSig(b) {
  return `${b.name}|${b.roof_level || ''}|${b.casing_bottom || ''}|${b.mine_floor || ''}`;
}

function renderMarkers() {
  if (!map) return;
  const list = activeBoreholes();
  const seen = new Set();
  for (const b of list) {
    seen.add(b.id);
    const existing = markers.get(b.id);
    if (existing) {
      if (existing._lat !== b.lat || existing._lng !== b.lng) {
        existing.setLatLng([b.lat, b.lng]);
        existing._lat = b.lat; existing._lng = b.lng;
      }
      const sig = markerSig(b);
      if (existing._sig !== sig) {
        existing.setIcon(pinIcon(b));
        existing.setPopupContent(popupHTML(b));
        existing._sig = sig;
      }
    } else {
      const m = L.marker([b.lat, b.lng], { icon: pinIcon(b) })
        .bindPopup(popupHTML(b), { className: 'pin-popup', offset: [0, -34], autoPanPadding: [24, 90] })
        .addTo(map);
      m._lat = b.lat; m._lng = b.lng; m._sig = markerSig(b);
      markers.set(b.id, m);
    }
  }
  for (const [id, m] of markers) {
    if (!seen.has(id)) { m.remove(); markers.delete(id); }
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
    sheet(`
      <h3>Add borehole</h3>
      <button class="btn primary big" id="add-here">${icon('crosshair')} Pin at my location</button>
      <button class="btn big" id="add-tap">${icon('map')} Tap the map to place</button>
    `);
    $('#add-here').onclick = () => {
      if (!myPos) { toast('No GPS fix yet — try "Tap the map" instead', 'warn'); return; }
      closeSheet();
      createAt({ lat: myPos.lat, lng: myPos.lng });
    };
    $('#add-tap').onclick = () => {
      closeSheet();
      armPlacing(latlng => createAt(latlng), 'Tap the map where the borehole is');
    };
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
        if (b) { flyToWell(b); openWell(b.id); }
      };
    });
  };
  input.oninput = debounce(render, 100);
  input.onfocus = () => { $('#search-panel').classList.add('open'); render(); };
  $('#search-close').onclick = hideSearch;
  function hideSearch() {
    $('#search-panel').classList.remove('open');
    input.value = '';
    input.blur();
  }

  $('#placing-cancel').onclick = stopPlacing;
}

export function armPlacing(cb, msg) {
  placing = cb;
  $('#placing-banner span').textContent = msg;
  $('#view-map').classList.add('placing');
  $('#placing-banner').classList.add('show');
}
function stopPlacing() {
  placing = null;
  $('#view-map').classList.remove('placing');
  $('#placing-banner').classList.remove('show');
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
