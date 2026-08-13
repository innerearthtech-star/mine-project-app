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
let previewMarker = null;    // draggable pin awaiting "Place here"
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
  });
  map.on('moveend', () => {
    const c = map.getCenter();
    DB.kvSet('mapView', { center: [c.lat, c.lng], zoom: map.getZoom() });
  });

  // While placing: a tap drops (or moves) a draggable preview pin; the
  // actual create/move only happens on "Place here".
  map.on('click', e => {
    if (placing) setPreview(e.latlng);
  });

  // wire the "Open well" button inside a pin's popup
  map.on('popupopen', e => wirePopupBtn(e.popup));

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
  return `${b.name}|${b.roof_level || ''}|${b.casing_bottom || ''}|${b.mine_floor || ''}`;
}

// (re)bind the popup's "Open well" button — needed again after a live
// sync updates the popup content while it's open
function wirePopupBtn(popup) {
  const node = popup && popup._contentNode;
  const btn = node && node.querySelector('[data-open]');
  if (btn) btn.onclick = () => { map.closePopup(); openWell(btn.dataset.open); };
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
        if (existing.isPopupOpen()) wirePopupBtn(existing.getPopup());
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
    stopPlacing(); // cancel any in-progress "tap to place" before re-entering
    sheet(`
      <h3>Add borehole</h3>
      <button class="btn primary big" id="add-here">${icon('crosshair')} Pin at my location</button>
      <button class="btn big" id="add-tap">${icon('map')} Tap the map to place</button>
    `);
    $('#add-here').onclick = () => {
      if (!myPos) { toast('No GPS fix yet — try "Tap the map" instead', 'warn'); return; }
      closeSheet();
      // preview at your GPS spot — drag to adjust, then confirm
      armPlacing(latlng => createAt(latlng), 'Drag the pin to adjust');
      map.flyTo([myPos.lat, myPos.lng], Math.max(map.getZoom(), 18), { duration: 0.5 });
      setPreview(L.latLng(myPos.lat, myPos.lng));
    };
    $('#add-tap').onclick = () => {
      closeSheet();
      armPlacing(latlng => createAt(latlng), 'Tap the map where the borehole is');
    };
  };

  $('#placing-confirm').onclick = () => {
    if (!previewMarker || !placing) return;
    const cb = placing;
    const ll = previewMarker.getLatLng();
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
          const m = markers.get(b.id);
          if (m) setTimeout(() => m.openPopup(), 850);
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

export function armPlacing(cb, msg) {
  stopPlacing(); // reset any earlier attempt (and its preview pin)
  placing = cb;
  $('#placing-banner span').textContent = msg;
  $('#placing-confirm').style.display = 'none';
  $('#view-map').classList.add('placing');
  $('#placing-banner').classList.add('show');
}

// Drop the draggable preview pin (or move it to a new tap point)
function setPreview(latlng) {
  if (!previewMarker) {
    previewMarker = L.marker(latlng, {
      draggable: true, zIndexOffset: 2000,
      icon: L.divIcon({
        className: 'pin-wrap',
        iconSize: [30, 40], iconAnchor: [15, 38],
        html: `
          <div class="pin pin-preview">
            <svg viewBox="0 0 30 40" width="30" height="40">
              <path d="M15 1C7.8 1 2 6.9 2 14.2 2 24.5 15 38 15 38S28 24.5 28 14.2C28 6.9 22.2 1 15 1z"
                    fill="var(--pin)" stroke="#00000055" stroke-width="1.5"/>
              <circle cx="15" cy="14" r="5.5" fill="#0b0f14"/>
            </svg>
          </div>`,
      }),
    }).addTo(map);
    $('#placing-banner span').textContent = 'Drag the pin to adjust';
    $('#placing-confirm').style.display = '';
  } else {
    previewMarker.setLatLng(latlng);
  }
}

function stopPlacing() {
  placing = null;
  if (previewMarker) { previewMarker.remove(); previewMarker = null; }
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
