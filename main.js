(() => {
'use strict';

const DB_NAME = 'FuentesDB';
const DB_VER = 1;
const STORE = 'fuentes';
const DATA_URL = 'fuentes_complete.json';
const DATA_JS = 'fuentes_complete.js';
const DATA_VER_KEY = 'fuentes_data_ver';
const DATA_VER = 6;
const IMG_PATH = 'images';
const TILE_LAYERS = {
  osm:  { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; <a href="https://osm.org/copyright">OSM</a>', maxZoom: 19 },
  topo: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attr: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17 },
  cyclo: { url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', attr: '&copy; <a href="https://cyclosm.org">CyclOSM</a>', maxZoom: 18 },
  sat:  { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: '&copy; <a href="https://esri.com">Esri</a>', maxZoom: 18 },
};

const ADMIN_PASSWORD = 'Lucian01';
const ADMIN_KEY = 'fuentes_admin';

const state = {
  db: null, allData: [], filtered: [], activeId: null,
  provincia: '', municipio: '', pedania: '', cuenca: '',
  map: null, markers: null, singleLayer: null,
  renderTimer: null,
  searchTerm: '',
  favorites: (() => { try { return JSON.parse(localStorage.getItem('fuentes_favorites') || '[]'); } catch(e) { return []; } })(),
  showFavoritesOnly: false,
  userCoords: null,
  userMarker: null,
  adminMode: (() => { try { return localStorage.getItem(ADMIN_KEY) === '1'; } catch(e) { return false; } })(),
};

function $(id) { return document.getElementById(id); }

function lsGet(key, def) { try { return localStorage.getItem(key); } catch(e) { return def; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch(e) {} }
function lsRemove(key) { try { localStorage.removeItem(key); } catch(e) {} }

/* ---------- Helper Functions ---------- */
function normalizeStr(s) {
  if (!s) return '';
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of Earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

const CUENCA_COLORS = {
  'Guadalete-Barbate':'#3498db','Guadalquivir':'#2ecc71','Guadiana':'#e74c3c',
  'Mediterránea Andaluza':'#e67e22','Segura':'#9b59b6','Tinto-Odiel-Piedras':'#1abc9c'
};
/* ---------- Edit System ---------- */
const EDITS_KEY = 'fuentes_edits';
let __editingId = null;
let __editOriginals = null;

function getEditsHash() {
  try { return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}'); } catch(e) { return {}; }
}

function saveEditsHash(h) {
  lsSet(EDITS_KEY, JSON.stringify(h));
}

function saveEditAction(id, changes, originals) {
  const h = getEditsHash();
  const sid = String(id);
  if (!h[sid]) {
    h[sid] = { changes: {}, originals: {}, timestamp: 0 };
  }
  Object.assign(h[sid].changes, changes);
  // Store originals only for fields not yet in the snapshot
  if (originals) {
    for (const k of Object.keys(changes)) {
      if (!(k in h[sid].originals)) {
        h[sid].originals[k] = originals[k];
      }
    }
  }
  h[sid].timestamp = Date.now();
  // Remove fields that match base value (no change)
  const base = state.allData.find(d => d.id_fuente === id);
  if (base) {
    for (const k of Object.keys(h[sid].changes)) {
      if (h[sid].changes[k] === base[k]) delete h[sid].changes[k];
    }
  }
  if (!Object.keys(h[sid].changes).length) {
    delete h[sid];
  }
  saveEditsHash(h);
}

function deleteEditAction(id) {
  const h = getEditsHash();
  const sid = String(id);
  const edit = h[sid];
  if (edit && edit.originals) {
    const record = state.allData.find(d => d.id_fuente === id);
    if (record) {
      for (const [k, v] of Object.entries(edit.originals)) {
        record[k] = (v === null || v === '') ? null : v;
      }
    }
  }
  delete h[sid];
  saveEditsHash(h);
}

function getEditAction(id) {
  const h = getEditsHash();
  return h[String(id)] || null;
}

function getCorrectionsCount() {
  return Object.keys(getEditsHash()).length;
}

function applyStoredEdits() {
  const h = getEditsHash();
  for (const [sid, edit] of Object.entries(h)) {
    const record = state.allData.find(d => d.id_fuente === parseInt(sid));
    if (record && edit.changes) {
      for (const [k, v] of Object.entries(edit.changes)) {
        if (v === null || v === '') record[k] = null;
        else if (k === 'altitud' || k === 'huso') record[k] = Number(v);
        else record[k] = v;
      }
    }
  }
}

let __dirHandle = null;

async function exportCorrectionsAction() {
  const h = getEditsHash();
  const arr = Object.entries(h).map(([id, edit]) => ({
    id: parseInt(id), changes: edit.changes, timestamp: edit.timestamp
  }));
  if (!arr.length) { showToast('No hay correcciones para exportar'); return; }

  if (!('showDirectoryPicker' in window)) {
    // Fallback: download via URL
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'correcciones.json'; a.click();
    URL.revokeObjectURL(url);
    showToast(arr.length + ' correcciones exportadas. Coloca el archivo en la carpeta del proyecto y ejecuta _aplicar.bat');
    lsRemove(EDITS_KEY);
    updateExportBadge();
    return;
  }

  // Helper: write a file via FS API
  async function writeFile(name, blob) {
    const fh = await __dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  try {
    if (!__dirHandle) {
      __dirHandle = await window.showDirectoryPicker({ id: 'fuentes-dir', mode: 'readwrite' });
    }

    showToast('Guardando correcciones...');

    // 1. Write corrections diff
    await writeFile('correcciones.json', new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' }));

    // 2. Write updated fuentes_complete.json with corrections baked in
    const cleanData = state.allData.map(d => {
      const o = {};
      for (const k in d) {
        if (k[0] !== '_') o[k] = d[k];
      }
      return o;
    });
    const jsonStr = JSON.stringify(cleanData);
    await writeFile('fuentes_complete.json', new Blob([jsonStr], { type: 'application/json' }));

    // 3. Write updated fuentes_complete.js
    const jsStr = 'window.FUENTES_DATA = ' + jsonStr + ';\n';
    await writeFile('fuentes_complete.js', new Blob([jsStr], { type: 'text/javascript' }));

    // Done — clear edits and reload
    lsRemove(EDITS_KEY);
    updateExportBadge();
    showToast(arr.length + ' correcciones guardadas permanentemente');
    setTimeout(() => { location.reload(); }, 1500);
  } catch(e) {
    __dirHandle = null;
    showToast('Error al guardar: ' + e.message);
  }
}

window.__exportCorrections = exportCorrectionsAction;

function updateExportBadge() {
  const btn = $('exportCorrectionsBtn');
  if (!btn) return;
  btn.style.display = state.adminMode ? '' : 'none';
  if (!state.adminMode) return;
  const cnt = getCorrectionsCount();
  btn.textContent = cnt ? '📥' + cnt : '📥';
  btn.title = cnt ? cnt + ' correcciones pendientes de exportar' : 'Exportar correcciones';
}

window.__openEdit = function(id) {
  __editingId = id;
  const d = state.allData.find(x => x.id_fuente === id);
  if (!d) return;
  __editOriginals = {};
  for (const k of Object.keys(d)) __editOriginals[k] = d[k];
  $('modal-info-view').style.display = 'none';
  $('modal-edit-form').style.display = 'block';
};

window.__cancelEdit = function() {
  __editingId = null; __editOriginals = null;
  $('modal-info-view').style.display = '';
  $('modal-edit-form').style.display = 'none';
};

window.__saveEdit = function(id) {
  const d = state.allData.find(x => x.id_fuente === id);
  if (!d) return;
  const form = $('modal-edit-form');
  const inputs = form.querySelectorAll('[name]');
  const changes = {};
  for (const inp of inputs) {
    const val = inp.type === 'number' ? (inp.value === '' ? null : Number(inp.value)) : inp.value;
    if (val !== __editOriginals[inp.name]) {
      changes[inp.name] = val;
    }
  }
  if (!Object.keys(changes).length) {
    showToast('No hay cambios que guardar');
    return;
  }
  // Capture original values BEFORE applying changes
  const originals = {};
  for (const k of Object.keys(changes)) {
    originals[k] = d[k];
  }
  // Apply to data in memory
  for (const [k, v] of Object.entries(changes)) {
    d[k] = (v === null || v === '') ? null : v;
  }
  saveEditAction(id, changes, originals);
  window.__cancelEdit();
  showModal(d);
  updateExportBadge();
  showToast('Corrección guardada');
};

window.__deleteEdit = function(id) {
  deleteEditAction(id);
  const d = state.allData.find(x => x.id_fuente === id);
  if (d) showModal(d);
  updateExportBadge();
  showToast('Edición deshecha');
};

const EDIT_FIELDS = [
  { key:'nombre', label:'Nombre' },
  { key:'provincia', label:'Provincia' },
  { key:'municipio', label:'Municipio' },
  { key:'pedania', label:'Pedanía' },
  { key:'altitud', label:'Altitud (m)' },
  { key:'cuenca', label:'Cuenca' },
  { key:'subcuenca', label:'Subcuenca' },
  { key:'rio_arroyo', label:'Río/Arroyo' },
  { key:'masa_agua_subterranea', label:'Masa Agua Subterránea' },
  { key:'espacio_natural_protegido', label:'Espacio Natural Protegido' },
  { key:'procedencia_lugar', label:'Procedencia Lugar' },
  { key:'naturaleza_rocas', label:'Naturaleza Rocas' },
  { key:'tipo_surgencia', label:'Tipo Surgencia' },
  { key:'caudal_medio', label:'Caudal Medio' },
  { key:'se_agota', label:'¿Se agota?' },
  { key:'acceso', label:'Acceso' },
  { key:'uso_publico_actual', label:'Uso Público Actual' },
  { key:'valoracion_instalaciones', label:'Valoración Instalaciones' },
  { key:'descripcion', label:'Descripción' },
  { key:'coordenada_x', label:'Coordenada X' },
  { key:'coordenada_y', label:'Coordenada Y' },
  { key:'huso', label:'Huso' },
];

/* ---------- End Edit System ---------- */

const PROV_CAPITALS = {
  'Almería': [36.8381, -2.4597], 'Cádiz': [36.5271, -6.2886],
  'Córdoba': [37.8882, -4.7794], 'Granada': [37.1773, -3.5986],
  'Huelva': [37.2614, -6.9447], 'Jaén': [37.7796, -3.7849],
  'Málaga': [36.7213, -4.4214], 'Sevilla': [37.3886, -5.9823]
};

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id_fuente' });
        os.createIndex('provincia', 'provincia', { unique: false });
        os.createIndex('tipo_surgencia', 'tipo_surgencia', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function getAllFromDB(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function populateDB(db, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    let count = 0;
    const total = data.length;
    for (const item of data) {
      const req = os.put(item);
      req.onsuccess = () => {
        count++;
        if (count % 250 === 0 || count === total) {
          showLoading(`Cargando base de datos (${Math.round(count / total * 100)}%)...`);
        }
      };
    }
    tx.oncomplete = () => resolve(total);
    tx.onerror = e => reject(tx.error || e.target.error);
  });
}

function loadDataViaScript() {
  return new Promise((resolve, reject) => {
    if (window.FUENTES_DATA) { resolve(window.FUENTES_DATA); return; }
    const handler = e => {
      document.removeEventListener('fuentesReady', handler);
      resolve(e.detail);
    };
    document.addEventListener('fuentesReady', handler);
    const s = document.createElement('script');
    s.src = DATA_JS;
    s.onerror = () => { document.removeEventListener('fuentesReady', handler); reject(new Error('Error al cargar '+DATA_JS)); };
    s.onload = () => {
      // Fallback: if event never fired but window.FUENTES_DATA is set
      if (window.FUENTES_DATA) {
        document.removeEventListener('fuentesReady', handler);
        resolve(window.FUENTES_DATA);
      }
    };
    document.head.appendChild(s);
    setTimeout(() => { document.removeEventListener('fuentesReady', handler); reject(new Error('Timeout cargando '+DATA_JS)); }, 60000);
  });
}

async function initData() {
  const storedVer = lsGet(DATA_VER_KEY);
  try { state.db = await openDB(); } catch(e) { state.db = null; }

  let needPopulate = storedVer != DATA_VER;
  if (!needPopulate && state.db) {
    const all = await getAllFromDB(state.db);
    if (!all.length) needPopulate = true;
  }

  if (needPopulate || !state.db) {
    showLoading('Cargando base de datos (primera vez)...');
    let data;
    try {
      // Try fetch first (works from HTTP/localhost)
      const resp = await fetch(DATA_URL);
      if (!resp.ok) throw new Error('HTTP '+resp.status);
      data = await resp.json();
    } catch(e) {
      // Fall back to dynamic script injection (works from file://)
      showLoading('Cargando datos offline...');
      data = await loadDataViaScript();
    }
    if (!data || !data.length) throw new Error('No hay datos');

    if (state.db) {
      const cnt = await populateDB(state.db, data);
      lsSet(DATA_VER_KEY, DATA_VER);
      console.log('IDB populated:', cnt, 'records');
    } else {
      state.allData = data;
    }
  }

  if (state.db) state.allData = await getAllFromDB(state.db);
  if (!state.allData.length) throw new Error('No hay datos disponibles');

  // Pedania cleanup: if it matches municipio, clear it
  for (const d of state.allData) {
    if (d.pedania && d.municipio && d.pedania.trim().toLowerCase() === d.municipio.trim().toLowerCase()) {
      d.pedania = null;
    }
  }

  // Apply stored user corrections
  applyStoredEdits();
}

/* ---------- Filtering ---------- */
function applyFilters() {
  state.filtered = state.allData.filter(d => {
    if (state.provincia && d.provincia !== state.provincia) return false;
    if (state.municipio && d.municipio !== state.municipio) return false;
    if (state.pedania && (d.pedania||'') !== state.pedania) return false;
    if (state.cuenca && d.cuenca !== state.cuenca) return false;
    if (state.showFavoritesOnly && !state.favorites.includes(d.id_fuente)) return false;
    if (state.searchTerm) {
      const nameNorm = normalizeStr(d.nombre);
      if (!nameNorm.includes(state.searchTerm)) return false;
    }
    return true;
  });

  if (state.userCoords) {
    for (const d of state.filtered) {
      if (isValidCoord(d.lat, d.lon)) {
        d._distance = getDistance(state.userCoords.lat, state.userCoords.lon, d.lat, d.lon);
      } else {
        d._distance = Infinity;
      }
    }
    state.filtered.sort((a, b) => a._distance - b._distance);
  } else {
    for (const d of state.filtered) {
      d._distance = null;
    }
  }
}

function updateUI() {
  applyFilters();
  renderMap();
  updateStats();
  updateHash();
  renderSidePanel();
}

/* ---------- Map ---------- */
function initMap() {
  state.map = L.map('map', { center: [37.5, -4.5], zoom: 7.5, zoomControl: false, attributionControl: false });
  state.tileLayers = {};
  for (const k in TILE_LAYERS) {
    state.tileLayers[k] = L.tileLayer(TILE_LAYERS[k].url, {
      attribution: TILE_LAYERS[k].attr, maxZoom: TILE_LAYERS[k].maxZoom
    });
  }
  state.currentLayer = lsGet('map_layer') || 'osm';
  state.tileLayers[state.currentLayer].addTo(state.map);
  state.markers = L.markerClusterGroup({ maxClusterRadius: 50, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true, disableClusteringAtZoom: 15 });
  state.map.addLayer(state.markers);
  state.map.on('moveend zoomend', () => {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(renderMap, 150);
  });

  // Sync layer button
  document.querySelectorAll('.layer-btn[data-layer]').forEach(b => b.classList.toggle('active', b.dataset.layer === state.currentLayer));
  // Layer switcher
  document.querySelectorAll('.layer-btn[data-layer]').forEach(btn => {
    btn.addEventListener('click', () => setLayer(btn.dataset.layer));
  });
  // Zoom buttons
  $('zoomIn').onclick = () => state.map.zoomIn();
  $('zoomOut').onclick = () => state.map.zoomOut();

  // GPS Button
  $('gpsBtn').onclick = () => {
    if (!navigator.geolocation) {
      showToast("La geolocalización no es compatible con este navegador.");
      return;
    }
    showToast("Obteniendo ubicación GPS...");
    navigator.geolocation.getCurrentPosition(pos => {
      state.userCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.map.setView([state.userCoords.lat, state.userCoords.lon], 15, { animate: true });
      
      if (state.userMarker) state.map.removeLayer(state.userMarker);
      const gpsIcon = L.divIcon({
        className: 'user-gps-marker',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });
      state.userMarker = L.marker([state.userCoords.lat, state.userCoords.lon], { icon: gpsIcon }).addTo(state.map);
      
      $('gpsBtn').classList.add('active');
      updateUI();
      showToast("Ubicación encontrada. Fuentes ordenadas por cercanía.");
    }, err => {
      showToast("No se pudo obtener la ubicación GPS.");
    }, { enableHighAccuracy: true, timeout: 8000 });
  };

  // Download Tiles Button
  $('downloadTilesBtn').onclick = downloadVisibleTiles;
}

/* ---------- Tile Downloader ---------- */
function lon2tile(lon, zoom) { return Math.floor((lon + 180) / 360 * Math.pow(2, zoom)); }
function lat2tile(lat, zoom) { return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)); }
function getTileRange(bounds, zoom) {
  const nw = bounds.getNorthWest();
  const se = bounds.getSouthEast();
  return {
    xMin: lon2tile(nw.lng, zoom),
    xMax: lon2tile(se.lng, zoom),
    yMin: lat2tile(nw.lat, zoom),
    yMax: lat2tile(se.lat, zoom)
  };
}
function getTileUrl(template, x, y, z) {
  const s = ['a', 'b', 'c'][Math.abs(x + y) % 3];
  return template.replace('{s}', s).replace('{x}', x).replace('{y}', y).replace('{z}', z);
}

async function downloadVisibleTiles() {
  if (!state.map) return;
  const bounds = state.map.getBounds();
  const template = TILE_LAYERS[state.currentLayer].url;
  const zooms = [11, 12, 13, 14];
  let tileUrls = [];

  let total = 0;
  const MAX_TILES = 600;
  outer:
  for (const z of zooms) {
    const r = getTileRange(bounds, z);
    for (let x = r.xMin; x <= r.xMax; x++) {
      for (let y = r.yMin; y <= r.yMax; y++) {
        tileUrls.push(getTileUrl(template, x, y, z));
        total++;
        if (total > MAX_TILES) break outer;
      }
    }
  }

  if (total === 0) {
    showToast("No hay mapas para descargar.");
    return;
  }
  if (total > MAX_TILES) {
    showToast(`Área demasiado grande (${total} teselas). Acerca el mapa.`);
    return;
  }

  showToast(`Descargando ${total} imágenes de mapa offline...`);
  try {
    const cache = await caches.open('osm-tiles-v1');
    let downloaded = 0;
    const concurrency = 6;
    const queue = [...tileUrls];

    async function worker() {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) continue;
        try {
          const req = new Request(url, { mode: 'cors' });
          const has = await cache.match(req);
          if (!has) {
            const resp = await fetch(req);
            if (resp.ok) await cache.put(req, resp);
          }
        } catch(e) {}
        downloaded++;
        if (downloaded % 25 === 0 || downloaded === total) {
          showToast(`Descarga de mapas: ${Math.round(downloaded/total*100)}%`);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    showToast("¡Mapa offline descargado y listo para usar!");
  } catch(e) {
    showToast("Error al guardar mapas offline.");
  }
}

function setLayer(name) {
  if (name === state.currentLayer) return;
  if (state.tileLayers[state.currentLayer]) state.map.removeLayer(state.tileLayers[state.currentLayer]);
  if (state.tileLayers[name]) state.tileLayers[name].addTo(state.map);
  state.currentLayer = name;
  lsSet('map_layer', name);
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
}

function renderMap() {
  // Use cluster when no province/cuenca, single layer when province or cuenca selected
  if (state.provincia || state.cuenca) { renderMapAll(); return; }
  state.markers.clearLayers();
  if (state.singleLayer) { state.map.removeLayer(state.singleLayer); state.singleLayer = null; }
  if (!state.filtered.length) return;

  const b = state.map.getBounds();
  const pad = 0.1;

  for (const d of state.filtered) {
    if (!isValidCoord(d.lat, d.lon)) continue;
    if (!b.contains([d.lat, d.lon]) &&
        (d.lat < b.getSouth()-pad || d.lat > b.getNorth()+pad ||
         d.lon < b.getWest()-pad || d.lon > b.getEast()+pad)) continue;
    addMarker(d);
  }
}

function renderMapAll() {
  state.markers.clearLayers();
  if (state.singleLayer) { state.map.removeLayer(state.singleLayer); state.singleLayer = null; }
  if (!state.filtered.length) return;

  state.singleLayer = L.layerGroup();
  state.singleLayer.addTo(state.map);
  for (const d of state.filtered) {
    if (isValidCoord(d.lat, d.lon)) addMarker(d);
  }
}

function addMarker(d) {
  const marker = L.circleMarker([d.lat, d.lon], {
    radius: d.id_fuente === state.activeId ? 10 : 6,
    fillColor: CUENCA_COLORS[d.cuenca] || '#666',
    color: '#fff', weight: 1, fillOpacity: 0.85
  });
  const meta = [d.tipo_surgencia, d.altitud ? d.altitud+' m' : ''].filter(Boolean).join(' · ');
  const popupHtml = `<div class="marker-popup"><div class="popup-photo-wrap"><img src="images/cf_${d.id_fuente}_1.jpg" onerror="this.style.display='none'" class="popup-img"></div><b>${esc(d.nombre)}</b><br><small>${esc(d.municipio)}, ${esc(d.provincia)}</small>${meta ? `<div class="popup-meta">${esc(meta)}</div>` : ''}</div>`;
  marker.bindPopup(popupHtml, { maxWidth: 220, className: 'marker-popup-wrap', closeButton: false });
  marker.fuenteId = d.id_fuente;
  const isTouch = 'ontouchstart' in window;
  if (!isTouch) {
    marker.on('mouseover', () => marker.openPopup());
    marker.on('mouseout', () => marker.closePopup());
  }
  marker.on('click', () => selectFuente(d.id_fuente));
  const target = state.singleLayer || state.markers;
  target.addLayer(marker);
}

/* ---------- Utils ---------- */
function isValidCoord(lat, lon) {
  return lat != null && lon != null && lat >= 35 && lat <= 44 && lon >= -10 && lon <= 5;
}

function fitToFiltered() {
  const coords = state.filtered.filter(d => isValidCoord(d.lat, d.lon)).map(d => [d.lat, d.lon]);
  if (!coords.length) return;
  if (coords.length === 1) {
    state.map.setView(coords[0], 14, { animate: true });
  } else {
    const isMobile = window.innerWidth <= 768;
    const panelOpen = !isMobile && !$('sidePanel').classList.contains('collapsed');
    if (panelOpen) {
      state.map.fitBounds(coords, { paddingTopLeft: [290, 30], paddingBottomRight: [50, 50] });
    } else {
      state.map.fitBounds(coords, { padding: [50, 50] });
    }
  }
}

function fitToMunicipio(muni) {
  const coords = state.allData.filter(d => d.municipio === muni && isValidCoord(d.lat, d.lon)).map(d => [d.lat, d.lon]);
  if (!coords.length) return;
  const lat = coords.reduce((s,c) => s+c[0], 0) / coords.length;
  const lon = coords.reduce((s,c) => s+c[1], 0) / coords.length;
  state.map.setView([lat, lon], 13, { animate: true });
}

/* ---------- Cards ---------- */
function renderCards() {}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ---------- Selection ---------- */
async function selectFuente(id) {
  state.activeId = id;
  const d = state.allData.find(x => x.id_fuente === id);
  if (!d) return;

  if (d.lat != null) {
    state.map.setView([d.lat, d.lon], 16, { animate: true });
    const layer = state.singleLayer || state.markers;
    layer.eachLayer(m => {
      if (m.fuenteId === id) {
        m.setStyle({ radius: 10, fillOpacity: 1 });
        m.openPopup();
      } else if (m.setStyle) {
        m.setStyle({ radius: 6, fillOpacity: 0.85 });
      }
    });
  }

  $('active-card-name').textContent = d.nombre;
  updateHash();
  await showModal(d);
}
window.selectFuente = selectFuente;

function updateHash() {
  history.replaceState(null, '', state.activeId ? `#fuente=${state.activeId}` : window.location.pathname);
}

/* ---------- Modal ---------- */
/* ---------- Favorites Toggle Function ---------- */
window.__toggleFav = function(id) {
  const idx = state.favorites.indexOf(id);
  if (idx === -1) {
    state.favorites.push(id);
  } else {
    state.favorites.splice(idx, 1);
  }
  lsSet('fuentes_favorites', JSON.stringify(state.favorites));
  
  const btn = $('modalFavBtn');
  if (btn) {
    const isFav = state.favorites.includes(id);
    btn.classList.toggle('active', isFav);
    btn.textContent = isFav ? '★' : '☆';
  }
  updateUI();
};

async function showModal(d) {
  const body = $('modal-body');
  const modal = $('modal');
  const id = d.id_fuente;
  const isFav = state.favorites.includes(id);
  const hasPhotoCounts = typeof window.PHOTO_COUNTS !== 'undefined';
  
  let maxPhotos = 0;
  let useFallbackOnError = false;
  
  if (hasPhotoCounts) {
    if (id in window.PHOTO_COUNTS) {
      maxPhotos = window.PHOTO_COUNTS[id];
    } else {
      maxPhotos = 1; // Intentar cargar al menos la primera foto
      useFallbackOnError = true;
    }
  } else {
    maxPhotos = 5; // Cargar hasta 5 con validación onerror si falla la carga del script
    useFallbackOnError = true;
  }

  const fields = [
    { l:'Provincia', v:d.provincia }, { l:'Municipio', v:d.municipio }, { l:'Pedanía', v:d.pedania },
    { l:'Altitud', v:d.altitud != null ? d.altitud+' m' : null },
    { l:'Cuenca', v:d.cuenca }, { l:'Río/Arroyo', v:d.rio_arroyo },
    { l:'Masa Agua Subterránea', v:d.masa_agua_subterranea },
    { l:'Espacio Natural Protegido', v:d.espacio_natural_protegido },
    { l:'Procedencia Lugar', v:d.procedencia_lugar }, { l:'Naturaleza Rocas', v:d.naturaleza_rocas },
    { l:'Tipo Surgencia', v:d.tipo_surgencia }, { l:'Caudal Medio', v:d.caudal_medio },
    { l:'¿Se agota?', v:d.se_agota }, { l:'Acceso', v:d.acceso },
    { l:'Uso Público Actual', v:d.uso_publico_actual },
    { l:'Valoración Instalaciones', v:d.valoracion_instalaciones },
  ].filter(f => f.v != null && f.v !== '');

  let gridHtml = fields.map(f =>
    `<div class="${f.l==='Acceso'?'full':''}"><span class="label">${f.l}</span><div class="value">${esc(f.v)}</div></div>`
  ).join('');

  let address = '';
  if (d.lat != null && d.lon != null) {
    address = `<div class="modal-actions">
      <a class="btn btn-accent" href="https://www.google.com/maps?q=${d.lat},${d.lon}" target="_self">🗺️ Google Maps</a>
      <a class="btn btn-sec" href="https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=16/${d.lat}/${d.lon}" target="_blank">🗺️ OpenStreetMap</a>
    </div>`;
  }

  let thumbs = '';
  let mainPhotoHtml = '';
  if (maxPhotos > 0) {
    const thumbsArray = [];
    for (let n = 1; n <= maxPhotos; n++) {
      const onerrorAttr = useFallbackOnError ? ` onerror="this.style.display='none';this.classList.add('missing-thumb')"` : '';
      thumbsArray.push(`<img src="images/cf_${id}_${n}.jpg"${onerrorAttr} class="gal-thumb${n===1?' active':''}" data-idx="${n-1}" onclick="window.__galGo(${n-1})">`);
    }
    thumbs = thumbsArray.join('');
    
    const mainOnerror = useFallbackOnError ? ` onerror="this.style.display='none';this.classList.add('missing-main')"` : '';
    mainPhotoHtml = `
      <button class="gal-arrow gal-prev" onclick="window.__galMove(-1)">&#9664;</button>
      <div class="gal-main-wrap">
        <img class="modal-img-inline" src="images/cf_${id}_1.jpg"${mainOnerror} alt="${esc(d.nombre)}" id="modal-main-img" onclick="window.__galFs()">
        <div class="gal-counter" id="gal-counter" style="${maxPhotos > 1 ? '' : 'display:none'}">1/${maxPhotos}</div>
        <button class="gal-fs-btn" onclick="event.stopPropagation();window.__galFs()" title="Ver a pantalla completa">⛶</button>
      </div>
      <button class="gal-arrow gal-next" onclick="window.__galMove(1)">&#9654;</button>
    `;
  }

  body.innerHTML = `
    <div id="modal-info-view">
    <div class="modal-info">
      <div class="modal-title">
        ${esc(d.nombre)}
        <button id="modalFavBtn" class="fav-btn-modal${isFav ? ' active' : ''}" onclick="window.__toggleFav(${id})" title="Marcar como favorito">${isFav ? '★' : '☆'}</button>
        ${state.adminMode ? `<button class="edit-btn" onclick="window.__openEdit(${id})" title="Editar ficha">✏️</button>` : ''}
      </div>
      <div class="modal-address">${esc(d.municipio)}${d.pedania ? ', '+esc(d.pedania) : ''}, ${esc(d.provincia)}</div>
      ${address}
      <div class="modal-desc-img">
        <div class="modal-desc-text">
          ${d.descripcion ? `<div class="desc-label">Descripción</div><div class="desc-value">${esc(d.descripcion)}</div>` : ''}
        </div>
        ${maxPhotos > 0 ? `
        <div class="modal-desc-photo">
          ${mainPhotoHtml}
        </div>
        <div class="gal-thumbs" id="gal-thumbs">${thumbs}</div>
        ` : ''}
      </div>
      <div class="modal-grid">${gridHtml}</div>
    </div>
    </div>
    <div id="modal-edit-form" style="display:none">
      <h3 style="margin-bottom:8px;font-size:.85rem">✏️ Editar ficha #${id}</h3>
      <div class="edit-grid">
        ${EDIT_FIELDS.map(f => {
          const val = d[f.key] != null ? d[f.key] : '';
          if (f.key === 'provincia') {
            const provs = [...new Set(state.allData.map(x => x.provincia))].sort();
            return `<label>${f.label} <select name="${f.key}">${provs.map(p => `<option value="${esc(p)}"${p===val?' selected':''}>${esc(p)}</option>`).join('')}</select></label>`;
          }
          if (f.key === 'cuenca') {
            const cuencas = [...new Set(state.allData.map(x => x.cuenca).filter(Boolean))].sort();
            return `<label>${f.label} <select name="${f.key}"><option value="">—</option>${cuencas.map(c => `<option value="${esc(c)}"${c===val?' selected':''}>${esc(c)}</option>`).join('')}</select></label>`;
          }
          const isLong = f.key === 'descripcion' || f.key === 'acceso';
          if (isLong) {
            return `<label class="edit-full">${f.label}<textarea name="${f.key}" rows="3">${esc(val)}</textarea></label>`;
          }
          const isNum = f.key === 'altitud' || f.key === 'huso';
          return `<label>${f.label} <input type="${isNum?'number':'text'}" name="${f.key}" value="${esc(val)}"></label>`;
        }).join('')}
      </div>
      <div class="edit-actions">
        <button onclick="window.__saveEdit(${id})" class="btn btn-accent">💾 Guardar</button>
        <span class="edit-actions-note">(solo campos modificados)</span>
        <button onclick="window.__cancelEdit()" class="btn btn-sec">Cancelar</button>
        ${getEditAction(id) ? `<button onclick="window.__deleteEdit(${id})" class="btn btn-del" style="margin-left:auto">🗑️ Deshacer edición</button>` : ''}
      </div>
    </div>
  `;

  /*---- gallery state ----*/
  const gid = id;
  window.__galIdx = 0;
  window.__galN = maxPhotos;
  window.__galId = gid;
  window.__galGo = function(i) {
    if (window.__galId !== gid) return;
    window.__galIdx = i;
    const img = document.getElementById('modal-main-img');
    if (img) {
      img.src = `images/cf_${gid}_${i+1}.jpg`;
      img.style.display = '';
    }
    document.querySelectorAll('.gal-thumb').forEach((t,j) => t.classList.toggle('active', j===i));
    updateCounter();
  };
  window.__galMove = function(d) {
    if (window.__galId !== gid || !window.__galN) return;
    let i = window.__galIdx + d;
    if (i < 0) i = window.__galN - 1;
    if (i >= window.__galN) i = 0;
    window.__galGo(i);
  };
  function updateCounter() {
    const c = document.getElementById('gal-counter');
    if (!c || !window.__galN) return;
    const show = window.__galN > 1;
    c.style.display = show ? '' : 'none';
    if (show) c.textContent = `${window.__galIdx+1}/${window.__galN}`;
  }
  window.__galFs = function() {
    if (window.__galId !== gid) return;
    const img = document.getElementById('modal-main-img');
    if (img && img.style.display !== 'none') {
      document.getElementById('fs-img').src = img.src;
      document.getElementById('fullscreen-photo').classList.add('show');
    }
  };

  if (useFallbackOnError) {
    // Detect actual photo count using preload
    let loaded = 0;
    const photos = [];
    function onAllChecked() {
      window.__galN = photos.length;
      const mainImg = document.getElementById('modal-main-img');
      if (photos.length === 0) {
        if (mainImg) mainImg.style.display = 'none';
        const photoWrap = document.querySelector('.modal-desc-photo');
        if (photoWrap) photoWrap.style.display = 'none';
      } else if (mainImg) {
        mainImg.src = `images/cf_${gid}_${photos[0]}.jpg`;
        mainImg.style.display = '';
        window.__galGo(0);
      }
      document.querySelectorAll('.gal-thumb').forEach(t => t.style.display = 'none');
      photos.forEach(i => {
        const t = document.querySelector(`.gal-thumb[data-idx="${i - 1}"]`);
        if (t) t.style.display = '';
      });
      updateCounter();
    }
    for (let i = 1; i <= 5; i++) {
      const p = new Image();
      p.onload = () => { loaded++; photos.push(i); if (loaded === 5) onAllChecked(); };
      p.onerror = () => { loaded++; if (loaded === 5) onAllChecked(); };
      p.src = `images/cf_${gid}_${i}.jpg`;
    }
  }

  modal.classList.add('show');
  modal.scrollTop = 0;
}

/* ---------- Side Panel ---------- */
function renderSidePanel() {
  const list = $('sideList');
  const panel = $('sidePanel');
  
  const hasFilter = state.provincia || state.cuenca || state.searchTerm || state.showFavoritesOnly || state.userCoords;
  if (!hasFilter) {
    list.innerHTML = '<div style="padding:.5rem;font-size:.72rem;color:var(--sub);text-align:center">Selecciona una provincia/cuenca, busca por nombre o usa el GPS</div>';
    panel.classList.add('collapsed');
    return;
  }

  panel.classList.remove('collapsed');
  
  const maxRender = 200;
  const itemsToRender = state.filtered.slice(0, maxRender);
  
  let listHtml = itemsToRender.map(d => {
    const hasPhotoCounts = typeof window.PHOTO_COUNTS !== 'undefined';
    const maxPhotos = hasPhotoCounts 
      ? (window.PHOTO_COUNTS[d.id_fuente] || 0) 
      : 1; // Fallback: asume 1 si no está cargado
      
    const imgHtml = maxPhotos > 0 
      ? `<img src="images/cf_${d.id_fuente}_1.jpg" onerror="this.style.display='none'" class="side-item-img">`
      : `<div class="side-item-img" style="display:flex;align-items:center;justify-content:center;font-size:1rem;background:var(--bg)">💧</div>`;
      
    const distText = d._distance && d._distance !== Infinity 
      ? ` · <b style="color:var(--accent)">📍 ${d._distance.toFixed(1)} km</b>` 
      : '';

    return `
      <div class="side-item${d.id_fuente === state.activeId ? ' active' : ''}" data-id="${d.id_fuente}" onclick="window.selectFuente(${d.id_fuente})">
        ${imgHtml}
        <div class="side-item-info">
          <div class="side-item-name">${esc(d.nombre)}</div>
          <div class="side-item-muni">${esc(d.municipio)}${d.pedania ? ', '+esc(d.pedania) : ''}${distText}</div>
          ${d.tipo_surgencia ? `<div class="side-item-type">${esc(d.tipo_surgencia)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (state.filtered.length > maxRender) {
    listHtml += `<div style="padding:.6rem;font-size:.65rem;color:var(--muted);text-align:center;border-top:1px solid var(--border)">Mostrando primeros ${maxRender} de ${state.filtered.length} resultados</div>`;
  } else if (state.filtered.length === 0) {
    listHtml = '<div style="padding:1rem;font-size:.72rem;color:var(--muted);text-align:center">No se encontraron resultados</div>';
  }

  list.innerHTML = listHtml;
  $('sideTitle').textContent = `Resultados (${state.filtered.length})`;
}


/* ---------- Stats ---------- */
function updateStats() {
  const st = $('statTotal'); const sf = $('statFiltered');
  if (st) st.textContent = state.allData.length.toLocaleString() + ' fuentes';
  if (sf) sf.textContent = state.filtered.length.toLocaleString() + ' mostradas';
}

/* ---------- Filters ---------- */
function buildFilters() {
  const provs = [...new Set(state.allData.map(d => d.provincia))].sort();

  function baseFiltered() {
    let f = state.allData;
    if (state.provincia) f = f.filter(d => d.provincia === state.provincia);
    if (state.cuenca) f = f.filter(d => d.cuenca === state.cuenca);
    return f;
  }

  function populateMuniPed() {
    const filtered = baseFiltered();
    const muniCounts = {};
    filtered.forEach(d => { if (d.municipio) muniCounts[d.municipio] = (muniCounts[d.municipio] || 0) + 1; });
    const munis = Object.keys(muniCounts).sort();

    const mSel = $('muniSelect');
    mSel.innerHTML = '<option value="">Municipio</option>' + munis.map(m => `<option value="${esc(m)}">${esc(m)} (${muniCounts[m]})</option>`).join('');

    populatePedOnly();
  }

  function populatePedOnly() {
    let filtered = baseFiltered();
    if (state.municipio) filtered = filtered.filter(d => d.municipio === state.municipio);
    const pedCounts = {};
    filtered.forEach(d => { if (d.pedania) pedCounts[d.pedania] = (pedCounts[d.pedania] || 0) + 1; });
    const peds = Object.keys(pedCounts).sort();

    const pSel = $('pedSelect');
    pSel.innerHTML = '<option value="">Pedanía</option>' + peds.map(p => `<option value="${esc(p)}">${esc(p)} (${pedCounts[p]})</option>`).join('');
  }

  function populateCuenca() {
    const filtered = state.provincia ? state.allData.filter(d => d.provincia === state.provincia) : state.allData;
    const cuencaCounts = {};
    filtered.forEach(d => { if (d.cuenca) cuencaCounts[d.cuenca] = (cuencaCounts[d.cuenca] || 0) + 1; });
    const cuencas = Object.keys(cuencaCounts).sort();
    const cSel = $('cuencaSelect');
    cSel.innerHTML = '<option value="">Cuenca</option>' + cuencas.map(c => `<option value="${esc(c)}">${esc(c)} (${cuencaCounts[c]})</option>`).join('');
  }

  const sel = $('provSelect');
  sel.innerHTML = '<option value="">Provincia</option>' +
    provs.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  sel.addEventListener('change', e => {
    state.provincia = e.target.value;
    state.municipio = '';
    state.pedania = '';
    state.cuenca = '';
    $('muniSelect').value = '';
    $('pedSelect').value = '';
    $('cuencaSelect').value = '';
    populateCuenca();
    populateMuniPed();
    applyFilters();
    if (state.provincia) {
      renderSidePanel();
      state.map.invalidateSize();
      renderMapAll();
      fitToFiltered();
    } else {
      state.map.setView([37.5, -4.5], 7.5, { animate: true });
      renderMap();
      renderSidePanel();
    }
    updateStats();
    updateHash();
  });

  $('muniSelect').addEventListener('change', e => {
    state.municipio = e.target.value;
    state.pedania = '';
    $('pedSelect').value = '';
    populatePedOnly();
    applyFilters();
    if (state.provincia || state.cuenca) { renderMapAll(); if (state.municipio) fitToMunicipio(state.municipio); else fitToFiltered(); }
    else renderMap();
    updateStats();
    updateHash();
    renderSidePanel();
  });

  $('pedSelect').addEventListener('change', e => {
    state.pedania = e.target.value;
    applyFilters();
    if (state.provincia || state.cuenca) { renderMapAll(); fitToFiltered(); }
    else renderMap();
    updateStats();
    updateHash();
    renderSidePanel();
  });

  $('cuencaSelect').addEventListener('change', e => {
    state.cuenca = e.target.value;
    state.municipio = '';
    state.pedania = '';
    $('muniSelect').value = '';
    $('pedSelect').value = '';
    populateMuniPed();
    applyFilters();
    renderSidePanel();
    state.map.invalidateSize();
    if (state.cuenca) { renderMapAll(); fitToFiltered(); }
    else if (state.provincia) { renderMapAll(); fitToFiltered(); }
    else { state.map.setView([37.5, -4.5], 7.5, { animate: true }); renderMap(); }
    updateStats();
    updateHash();
  });

  // Text search listener
  $('textSearch').addEventListener('input', e => {
    state.searchTerm = normalizeStr(e.target.value);
    updateUI();
  });

  // Favorites toggle listener
  $('favsToggleBtn').addEventListener('click', () => {
    state.showFavoritesOnly = !state.showFavoritesOnly;
    $('favsToggleBtn').classList.toggle('active', state.showFavoritesOnly);
    updateUI();
  });

  populateMuniPed();
  populateCuenca();
}

/* ---------- Side Panel Init ---------- */
function initSidePanel() {
  const panel = $('sidePanel');
  const backdrop = $('sideBackdrop');
  const hamburger = $('hamburgerBtn');

  function closePanel() {
    panel.classList.add('collapsed');
    if (backdrop) backdrop.classList.add('hidden');
  }

  function openPanel() {
    panel.classList.remove('collapsed');
    if (backdrop) backdrop.classList.remove('hidden');
  }

  $('sideClose').onclick = closePanel;

  if (backdrop) backdrop.onclick = closePanel;

  if (hamburger) {
    hamburger.onclick = () => {
      if (panel.classList.contains('collapsed')) {
        const hasFilter = state.provincia || state.cuenca || state.searchTerm || state.showFavoritesOnly || state.userCoords;
        if (!hasFilter || !state.filtered.length) return;
        openPanel();
      } else {
        closePanel();
      }
    };
  }

  // Close on mobile when tapping map
  $('map').addEventListener('click', () => {
    if (window.innerWidth <= 768 && !panel.classList.contains('collapsed')) closePanel();
  });

  // Sync backdrop with panel state after each render
  const origRender = renderSidePanel;
  renderSidePanel = function() {
    origRender();
    if (backdrop) {
      if (panel.classList.contains('collapsed')) backdrop.classList.add('hidden');
      else backdrop.classList.remove('hidden');
    }
  };
}

/* ---------- Admin ---------- */
function updateAdminBadge() {
  let badge = document.getElementById('adminBadge');
  if (state.adminMode) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'adminBadge';
      badge.className = 'admin-badge';
      badge.textContent = 'ADMIN';
      document.body.appendChild(badge);
    }
  } else {
    if (badge) badge.remove();
  }
}

function activateAdmin(pwd) {
  if (pwd === ADMIN_PASSWORD) {
    state.adminMode = true;
    lsSet(ADMIN_KEY, '1');
    updateAdminBadge();
    showToast('Modo admin activado');
    return true;
  }
  showToast('Contraseña incorrecta');
  return false;
}

function deactivateAdmin() {
  state.adminMode = false;
  lsRemove(ADMIN_KEY);
  updateAdminBadge();
  showToast('Modo admin desactivado');
}

function showAdminLogin(adminLink) {
  const modal = $('modal');
  const body = $('modal-body');
  body.innerHTML = `
    <div class="modal-info" style="text-align:center;padding:1.5rem">
      <div style="font-size:2rem;margin-bottom:.5rem">🔒</div>
      <h3 style="color:var(--accent);font-size:1rem;margin-bottom:1rem">Acceso de Administrador</h3>
      <input type="password" id="adminPwdInput" placeholder="Contraseña" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:.4rem .6rem;font-size:.9rem;width:200px;outline:none;text-align:center" autofocus>
      <div style="margin-top:.8rem;display:flex;gap:6px;justify-content:center">
        <button id="adminLoginBtn" class="btn btn-accent">Entrar</button>
        <button class="btn btn-sec" onclick="document.getElementById('modal').classList.remove('show')">Cancelar</button>
      </div>
      <div id="adminLoginError" style="color:#ef4444;font-size:.75rem;margin-top:.5rem;display:none"></div>
    </div>
  `;
  modal.classList.add('show');
  const input = document.getElementById('adminPwdInput');
  const loginBtn = document.getElementById('adminLoginBtn');
  const errorEl = document.getElementById('adminLoginError');
  function tryLogin() {
    const val = input.value;
    if (!val) { errorEl.textContent = 'Introduce la contraseña'; errorEl.style.display = ''; return; }
    if (activateAdmin(val)) {
      modal.classList.remove('show');
      adminLink.textContent = '🔓';
    } else {
      errorEl.textContent = 'Contraseña incorrecta';
      errorEl.style.display = '';
      input.value = '';
      input.focus();
    }
  }
  loginBtn.onclick = tryLogin;
  input.onkeydown = e => { if (e.key === 'Enter') tryLogin(); };
  setTimeout(() => input.focus(), 100);
}

/* ---------- Legal ---------- */
function initLegal() {
  if (!lsGet('cookies_accepted')) $('cookie-banner').style.display = 'block';
  $('cb-accept').onclick = () => { lsSet('cookies_accepted','1'); $('cookie-banner').style.display='none'; };
  $('cb-info').onclick = () => showLegal('cookies');
  $('link-legal').onclick = e => { e.preventDefault(); showLegal('legal'); };
  $('link-privacy').onclick = e => { e.preventDefault(); showLegal('privacy'); };
  $('link-cookies').onclick = e => { e.preventDefault(); showLegal('cookies'); };

  const adminLink = $('link-admin');
  if (adminLink) {
    if (state.adminMode) {
      adminLink.textContent = '🔓';
    }
    adminLink.onclick = e => {
      e.preventDefault();
      if (state.adminMode) {
        deactivateAdmin();
        adminLink.textContent = '🔒';
      } else {
        showAdminLogin(adminLink);
      }
    };
  }
}

function showLegal(section) {
  const modal = $('legal-modal');
  const texts = {
    legal: '<h2>Aviso Legal</h2><p>Información sobre fuentes y manantiales de Andalucía con fines divulgativos. Datos: Consejería de Medio Ambiente.</p>',
    privacy: '<h2>Privacidad</h2><p>App 100% offline. No recopilamos ni compartimos datos. Todo se almacena localmente (IndexedDB/localStorage).</p>',
    cookies: '<h2>Cookies</h2><p>Solo almacenamiento local para preferencias. Sin cookies de rastreo ni terceros.</p>'
  };
  $('legal-body').innerHTML = texts[section] || '';
  modal.style.display = 'block';
  modal.querySelector('.modal-close').onclick = () => { modal.style.display = 'none'; };
  modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
}

/* ---------- UI Events ---------- */
$('modal').querySelector('.close-btn').onclick = () => $('modal').classList.remove('show');
$('modal').onclick = e => { if (e.target === $('modal')) $('modal').classList.remove('show'); };

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const fsPhoto = $('fullscreen-photo');
    if (fsPhoto && fsPhoto.classList.contains('show')) {
      fsPhoto.classList.remove('show');
    } else {
      $('modal').classList.remove('show');
    }
  } else if (e.key === 'ArrowLeft') {
    if ($('modal').classList.contains('show') && typeof window.__galMove === 'function') {
      window.__galMove(-1);
    }
  } else if (e.key === 'ArrowRight') {
    if ($('modal').classList.contains('show') && typeof window.__galMove === 'function') {
      window.__galMove(1);
    }
  }
});

/* ---------- Loading ---------- */
function showLoading(msg) { const el = $('loading-text'); if (el) el.textContent = msg || 'Cargando...'; }
function hideLoading() { const el = $('loading'); if (el) el.style.display = 'none'; }

/* ---------- SW ---------- */
function initSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed:', e));
  }
}

/* ---------- Init ---------- */
(async function init() {
  try { await initData(); } catch(e) {
    $('loading').innerHTML = '<div style="color:var(--accent);font-size:1.2rem">⚠️</div><p>Error: '+esc(e.message)+'</p>';
    return;
  }
  initMap();
  buildFilters();
  initSidePanel();
  updateUI();
  updateExportBadge();
  initLegal();
  updateAdminBadge();
  initSW();
  hideLoading();

  const hashId = parseInt(location.hash.match(/fuente=(\d+)/)?.[1]);
  if (hashId && state.allData.find(d => d.id_fuente === hashId)) {
    setTimeout(() => selectFuente(hashId), 400);
  }
})();

})();
