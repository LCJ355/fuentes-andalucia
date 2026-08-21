(() => {
'use strict';

const DB_NAME = 'FuentesDB';
const DB_VER = 2;
const STORE = 'fuentes';
const PHOTO_EDIT_STORE = 'photo_edits';
const DATA_URL = 'fuentes_complete.json';
const DATA_JS = 'fuentes_complete.js';
const DATA_VER_KEY = 'fuentes_data_ver';
const DATA_VER = 6;
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
  fitTimer: null,
  searchTerm: '',
  userCoords: null,
  photoEdits: {},
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
let __pendingPhotos = [];

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
  // Clear photo edits for this source
  if (state.photoEdits[id]) {
    delete state.photoEdits[id];
    clearPhotoEditRec(state.db, id);
  }
}

function getEditAction(id) {
  const h = getEditsHash();
  return h[String(id)] || null;
}

function getCorrectionsCount() {
  const ids = new Set(Object.keys(getEditsHash()));
  for (const k of Object.keys(state.photoEdits)) ids.add(k);
  return ids.size;
}

function applyStoredEdits() {
  const h = getEditsHash();
  for (const [sid, edit] of Object.entries(h)) {
    const record = state.allData.find(d => d.id_fuente === parseInt(sid));
    if (record && edit.changes) {
      for (const [k, v] of Object.entries(edit.changes)) {
        if (k === '_photos') continue;
        if (v === null || v === '') record[k] = null;
        else if (k === 'altitud' || k === 'huso') record[k] = Number(v);
        else record[k] = v;
      }
    }
  }
}

let __dirHandle = null;

async function writeFileInDir(dirHandle, name, blob) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

async function writeFile(name, blob) {
  await writeFileInDir(__dirHandle, name, blob);
}

// Writes added photos, deletes removed ones (renumbering), and regenerates photo_counts.js
async function applyPhotoEditsToDisk() {
  const edits = state.photoEdits;
  const ids = Object.keys(edits);
  if (!ids.length) return;

  const imgsHandle = await __dirHandle.getDirectoryHandle('images', { create: true });
  const finalCounts = Object.assign({}, window.PHOTO_COUNTS || {});
  let processed = 0;

  for (const id of ids) {
    const pe = edits[id];
    const removeSet = new Set((pe.remove || []).map(Number));
    const idNum = parseInt(id);

    // List existing files cf_ID_*.jpg
    const files = {};
    for await (const [name, handle] of imgsHandle.entries()) {
      const m = /^cf_(\d+)_(\d+)\.(jpg|jpeg|png)$/i.exec(name);
      if (m && parseInt(m[1]) === idNum) files[parseInt(m[2])] = { name, handle };
    }

    // Delete marked photos
    for (const n of removeSet) {
      if (files[n]) {
        await imgsHandle.removeEntry(files[n].name);
        delete files[n];
      }
    }

    // Renumber remaining files sequentially
    const remaining = Object.keys(files).map(Number).sort((a, b) => a - b);
    let next = 1;
    for (const n of remaining) {
      if (n !== next) {
        const file = await files[n].handle.getFile();
        const bytes = await file.arrayBuffer();
        await writeFileInDir(imgsHandle, `cf_${idNum}_${next}.jpg`, new Blob([bytes], { type: file.type || 'image/jpeg' }));
        await imgsHandle.removeEntry(files[n].name);
      }
      next++;
    }

    // Write added photos at the next free indices
    for (const a of (pe.add || [])) {
      await writeFileInDir(imgsHandle, `cf_${idNum}_${next}.jpg`,
        new Blob([base64ToBytes(a.data)], { type: dataUrlMime(a.data) }));
      next++;
    }

    if (next - 1 > 0) finalCounts[id] = next - 1;
    else delete finalCounts[id];

    processed++;
    if (processed % 10 === 0) showToast(`Guardando fotos... ${processed}/${ids.length}`);
  }

  const jsStr = 'window.PHOTO_COUNTS = ' + JSON.stringify(finalCounts) + ';\n';
  await writeFile('photo_counts.js', new Blob([jsStr], { type: 'text/javascript' }));
  showToast('Fotos guardadas (' + ids.length + ' fuentes)');
}

async function exportCorrectionsAction() {
  const h = getEditsHash();
  const arr = Object.entries(h).map(([id, edit]) => ({
    id: parseInt(id), changes: edit.changes, timestamp: edit.timestamp
  }));
  const photoIds = Object.keys(state.photoEdits);
  if (!arr.length && !photoIds.length) { showToast('No hay correcciones para exportar'); return; }

  if (!('showDirectoryPicker' in window)) {
    // Fallback: download via URL (text corrections only)
    const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'correcciones.json'; a.click();
    URL.revokeObjectURL(url);
    if (photoIds.length) {
      showToast('Correcciones de texto exportadas. Las fotos requieren Chromium para guardarse en disco.');
    } else {
      showToast(arr.length + ' correcciones exportadas. Coloca el archivo en la carpeta del proyecto y ejecuta _aplicar.bat');
    }
    lsRemove(EDITS_KEY);
    return;
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

    // 4. Apply photo edits (write/remove/renumber images + photo_counts.js)
    if (photoIds.length) await applyPhotoEditsToDisk();

    // Done — clear edits and reload
    lsRemove(EDITS_KEY);
    await removeAllPhotoEdits();
    showToast(arr.length + ' correcciones guardadas permanentemente');
    setTimeout(() => { location.reload(); }, 1500);
  } catch(e) {
    __dirHandle = null;
    showToast('Error al guardar: ' + e.message);
  }
}

window.__exportCorrections = exportCorrectionsAction;

window.__openEdit = function(id) {
  __editingId = id;
  __pendingPhotos = [];
  const d = state.allData.find(x => x.id_fuente === id);
  if (!d) return;
  __editOriginals = {};
  for (const k of Object.keys(d)) __editOriginals[k] = d[k];
  $('modal-info-view').style.display = 'none';
  $('modal-edit-form').style.display = 'block';
  // Init file input
  const fileInp = document.getElementById('photoAddInput');
  const prev = document.getElementById('photoPreview');
  if (fileInp && prev) {
    fileInp.value = '';
    prev.innerHTML = '';
    // Show already-added photos (pending export)
    const existing = (state.photoEdits[id] && state.photoEdits[id].add) || [];
    for (const a of existing) {
      const thumb = document.createElement('img');
      thumb.src = a.data;
      thumb.style.cssText = 'width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--accent)';
      thumb.title = (a.name || 'foto añadida') + ' (pendiente de exportar)';
      prev.appendChild(thumb);
    }
    fileInp.onchange = function() {
      const files = Array.from(this.files);
      files.forEach(f => {
        const reader = new FileReader();
        reader.onload = function(e) {
          __pendingPhotos.push({ name: f.name, data: e.target.result });
          const thumb = document.createElement('img');
          thumb.src = e.target.result;
          thumb.style.cssText = 'width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border)';
          thumb.title = f.name;
          prev.appendChild(thumb);
        };
        reader.readAsDataURL(f);
      });
    };
  }
};

window.__cancelEdit = function() {
  __editingId = null; __editOriginals = null; __pendingPhotos = [];
  $('modal-info-view').style.display = '';
  $('modal-edit-form').style.display = 'none';
};

window.__saveEdit = function(id) {
  const d = state.allData.find(x => x.id_fuente === id);
  if (!d) return;
  const form = $('modal-edit-form');
  const inputs = form.querySelectorAll('[name]');
  const changes = {};
  const removeIdx = [];
  for (const inp of inputs) {
    if (inp.name.startsWith('_photo_remove_')) {
      if (inp.checked) removeIdx.push(parseInt(inp.name.replace('_photo_remove_', '')));
      continue;
    }
    const val = inp.type === 'number' ? (inp.value === '' ? null : Number(inp.value)) : inp.value;
    if (val !== __editOriginals[inp.name]) {
      changes[inp.name] = val;
    }
  }
  const adds = (window.__pendingPhotos && window.__pendingPhotos.length) ? window.__pendingPhotos : [];
  const hasPhotoOps = removeIdx.length > 0 || adds.length > 0;
  if (!Object.keys(changes).length && !hasPhotoOps) {
    showToast('No hay cambios que guardar');
    return;
  }
  if (hasPhotoOps) {
    savePhotoEditOps(id, removeIdx, adds);
  }
  if (Object.keys(changes).length) {
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
  }
  window.__cancelEdit();
  showModal(d);
  showToast('Corrección guardada');
};

window.__deleteEdit = function(id) {
  deleteEditAction(id);
  const d = state.allData.find(x => x.id_fuente === id);
  if (d) showModal(d);
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
      if (!db.objectStoreNames.contains(PHOTO_EDIT_STORE)) {
        db.createObjectStore(PHOTO_EDIT_STORE, { keyPath: 'id' });
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
  const BATCH = 500;
  const total = data.length;
  let count = 0;
  return (async () => {
    for (let i = 0; i < total; i += BATCH) {
      const chunk = data.slice(i, i + BATCH);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        for (const item of chunk) os.put(item);
        tx.oncomplete = () => {
          count += chunk.length;
          if (count % 250 === 0 || count === total) {
            showLoading(`Cargando base de datos (${Math.round(count / total * 100)}%)...`);
          }
          resolve();
        };
        tx.onerror = e => reject(tx.error || e.target.error);
      });
    }
    return total;
  })();
}

/* ---------- Photo Edits (IndexedDB) ---------- */
function getAllPhotoEdits(db) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve([]); return; }
    const tx = db.transaction(PHOTO_EDIT_STORE, 'readonly');
    const req = tx.objectStore(PHOTO_EDIT_STORE).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function savePhotoEditRec(db, rec) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(PHOTO_EDIT_STORE, 'readwrite');
    tx.objectStore(PHOTO_EDIT_STORE).put(rec);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(tx.error || e.target.error);
  });
}

function clearPhotoEditRec(db, id) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(PHOTO_EDIT_STORE, 'readwrite');
    tx.objectStore(PHOTO_EDIT_STORE).delete(parseInt(id));
    tx.oncomplete = resolve;
    tx.onerror = e => reject(tx.error || e.target.error);
  });
}

function clearAllPhotoEdits(db) {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(); return; }
    const tx = db.transaction(PHOTO_EDIT_STORE, 'readwrite');
    tx.objectStore(PHOTO_EDIT_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = e => reject(tx.error || e.target.error);
  });
}

function savePhotoEditOps(id, removeIdx, adds) {
  const pe = state.photoEdits[id] || { remove: [], add: [] };
  pe.remove = [...new Set([...pe.remove, ...removeIdx])];
  pe.add = pe.add.concat(adds || []);
  state.photoEdits[id] = pe;
  if (state.db) {
    savePhotoEditRec(state.db, { id: parseInt(id), remove: pe.remove, add: pe.add })
      .catch(() => showToast('No se pudieron guardar las fotos en IndexedDB'));
  } else {
    showToast('Sin IndexedDB: las fotos se mantienen solo en esta sesión');
  }
}

async function removeAllPhotoEdits() {
  state.photoEdits = {};
  await clearAllPhotoEdits(state.db);
}

function getBasePhotoCount(id) {
  if (typeof window.PHOTO_COUNTS !== 'undefined') {
    return (id in window.PHOTO_COUNTS) ? window.PHOTO_COUNTS[id] : 0;
  }
  return 0;
}

function buildEffectivePhotoList(id, baseCount) {
  const pe = state.photoEdits[id];
  const removeSet = new Set((pe && pe.remove || []).map(Number));
  const list = [];
  for (let n = 1; n <= baseCount; n++) {
    if (!removeSet.has(n)) list.push(`images/cf_${id}_${n}.jpg`);
  }
  for (const a of (pe && pe.add || [])) list.push(a.data);
  return list;
}

function getSidePanelPhotoHTML(id) {
  const base = getBasePhotoCount(id) || (typeof window.PHOTO_COUNTS === 'undefined' ? 1 : 0);
  const list = buildEffectivePhotoList(id, base);
  if (!list.length) {
    return '<div class="side-item-img" style="display:flex;align-items:center;justify-content:center;font-size:.7rem;background:var(--bg);color:var(--sub)">~</div>';
  }
  return `<img src="${esc(list[0])}" onerror="this.style.display='none'" class="side-item-img">`;
}

function base64ToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]+)/.exec(dataUrl);
  return m ? m[1] : 'image/jpeg';
}

function loadDataViaScript() {
  return new Promise((resolve, reject) => {
    if (window.FUENTES_DATA) { resolve(window.FUENTES_DATA); return; }
    let settled = false;
    let timer = null;
    const done = (val, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener('fuentesReady', handler);
      if (err) reject(err); else resolve(val);
    };
    const handler = e => done(e.detail);
    document.addEventListener('fuentesReady', handler);
    const s = document.createElement('script');
    s.src = DATA_JS;
    s.onerror = () => done(null, new Error('Error al cargar '+DATA_JS));
    s.onload = () => {
      // Fallback: if event never fired but window.FUENTES_DATA is set
      if (window.FUENTES_DATA) done(window.FUENTES_DATA);
    };
    document.head.appendChild(s);
    timer = setTimeout(() => done(null, new Error('Timeout cargando '+DATA_JS)), 60000);
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

  // Load stored photo edits
  state.photoEdits = {};
  try {
    const pes = await getAllPhotoEdits(state.db);
    for (const p of pes) state.photoEdits[p.id] = { remove: p.remove || [], add: p.add || [] };
  } catch(e) {}

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
    if (state.searchTerm) {
      const searchable = [d.nombre, d.municipio, d.pedania, d.cuenca, d.subcuenca, d.rio_arroyo, d.descripcion, d.tipo_surgencia]
        .map(normalizeStr).join(' ');
      if (!searchable.includes(state.searchTerm)) return false;
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
  document.querySelectorAll('.layer-opt').forEach(b => b.classList.toggle('active', b.dataset.layer === state.currentLayer));
  const activeOpt = document.querySelector('.layer-opt.active');
  document.getElementById('layerToggle').textContent = (activeOpt ? activeOpt.textContent : state.currentLayer) + ' ▼';
  // Layer switcher (dropdown)
  document.querySelectorAll('.layer-opt').forEach(btn => {
    btn.addEventListener('click', () => setLayer(btn.dataset.layer, btn.textContent));
  });
  document.getElementById('layerToggle').onclick = e => {
    e.stopPropagation();
    document.getElementById('layerMenu').classList.toggle('open');
    document.getElementById('layerToggle').classList.toggle('open');
  };
  document.addEventListener('click', closeLayerMenu);
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

function closeLayerMenu() {
  document.getElementById('layerMenu').classList.remove('open');
  document.getElementById('layerToggle').classList.remove('open');
}

function setLayer(name, label) {
  if (name === state.currentLayer) return;
  if (state.tileLayers[state.currentLayer]) state.map.removeLayer(state.tileLayers[state.currentLayer]);
  if (state.tileLayers[name]) state.tileLayers[name].addTo(state.map);
  state.currentLayer = name;
  lsSet('map_layer', name);
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
  document.querySelectorAll('.layer-opt').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
  document.getElementById('layerToggle').textContent = (label || name) + ' ▼';
  closeLayerMenu();
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
async function showModal(d) {
  const body = $('modal-body');
  const modal = $('modal');
  const id = d.id_fuente;
  const gid = id;

  // ---- Photo model ----
  const countsKnown = typeof window.PHOTO_COUNTS !== 'undefined';
  const baseCount = countsKnown ? (id in window.PHOTO_COUNTS ? window.PHOTO_COUNTS[id] : 0) : 0;
  const pe = state.photoEdits[id];
  const removeSet = new Set((pe && pe.remove || []).map(Number));
  const additions = (pe && pe.add) || [];
  const hasAdds = additions.length > 0;
  // Detect by preload when the count is unknown (stale/missing PHOTO_COUNTS)
  const needDetect = !countsKnown || (!(id in window.PHOTO_COUNTS) && !hasAdds);

  const photoList = needDetect ? [] : buildEffectivePhotoList(id, baseCount);
  const removableBase = needDetect ? [] : Array.from({ length: baseCount }, (_, i) => i + 1).filter(n => !removeSet.has(n));
  const hasEdits = !!(getEditAction(id) || state.photoEdits[id]);

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
      <a class="btn btn-accent" href="https://www.google.com/maps?q=${d.lat},${d.lon}" target="_self">[M] Google Maps</a>
      <a class="btn btn-sec" href="https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=16/${d.lat}/${d.lon}" target="_blank">[M] OpenStreetMap</a>
    </div>`;
  }

  const galleryHtml = photoList.length ? buildGalleryHtml(photoList, d.nombre) : '<div class="gal-none">Sin fotos</div>';

  body.innerHTML = `
    <div id="modal-info-view">
    <div class="modal-info">
      <div class="modal-title">
        ${esc(d.nombre)}
      </div>
      <div class="modal-address">${esc(d.municipio)}${d.pedania ? ', '+esc(d.pedania) : ''}, ${esc(d.provincia)}</div>
      ${address}
      <div class="modal-desc-img">
        <div class="modal-desc-text">
          ${d.descripcion ? `<div class="desc-label">Descripción</div><div class="desc-value">${esc(d.descripcion)}</div>` : ''}
        </div>
        <div class="modal-desc-photo">
          <div id="modal-gallery">${galleryHtml}</div>
        </div>
      </div>
      <div class="modal-grid">${gridHtml}</div>
      <div style="display:flex;justify-content:flex-end;gap:4px;margin-top:8px">
        ${state.adminMode ? `<button class="btn btn-sec" onclick="window.__toggleAdmin(${id})" style="font-size:.65rem">Admin OFF</button>
        <button class="btn btn-accent" onclick="window.__openEdit(${id})" style="font-size:.65rem">Edit</button>
        ${getCorrectionsCount() ? `<button class="btn btn-sec" onclick="window.__exportCorrections()" style="font-size:.65rem">Exportar (${getCorrectionsCount()})</button>` : ''}` : `<button class="btn btn-accent" onclick="window.__toggleAdmin(${id})" style="font-size:.65rem">Admin ON</button>`}
      </div>
    </div>
    </div>
    <div id="modal-edit-form" style="display:none">
      <h3 style="margin-bottom:8px;font-size:.85rem">[Editar] ficha #${id}</h3>
      <div class="edit-grid">
        ${EDIT_FIELDS.map(f => {
          const val = d[f.key] != null ? d[f.key] : '';
          if (f.key === 'provincia') {
            const provs = [...new Set(state.allData.map(x => x.provincia))].sort();
            return `<label>${f.label} <select name="${f.key}">${provs.map(p => `<option value="${esc(p)}"${p===val?' selected':''}>${esc(p)}</option>`).join('')}</select></label>`;
          }
          if (f.key === 'cuenca') {
            const cuencas = [...new Set(state.allData.map(x => x.cuenca).filter(Boolean))].sort();
            return `<label>${f.label} <select name="${f.key}"><option value="">-</option>${cuencas.map(c => `<option value="${esc(c)}"${c===val?' selected':''}>${esc(c)}</option>`).join('')}</select></label>`;
          }
          const isLong = f.key === 'descripcion' || f.key === 'acceso';
          if (isLong) {
            return `<label class="edit-full">${f.label}<textarea name="${f.key}" rows="3">${esc(val)}</textarea></label>`;
          }
          const isNum = f.key === 'altitud' || f.key === 'huso';
          return `<label>${f.label} <input type="${isNum?'number':'text'}" name="${f.key}" value="${esc(val)}"></label>`;
        }).join('')}
      </div>
      <div class="edit-photo-section" style="margin-top:8px;padding:6px;background:var(--bg);border-radius:var(--radius);border:1px solid var(--border)">
        <div style="font-size:.7rem;font-weight:600;color:var(--accent);margin-bottom:4px">Fotos</div>
        ${removableBase.length ? `<div style="font-size:.6rem;color:var(--muted);margin-bottom:3px">Marcar para eliminar:</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${removableBase.map(n => `
          <label style="font-size:.6rem;display:flex;align-items:center;gap:2px;color:var(--text)"><input type="checkbox" name="_photo_remove_${n}" value="1"> foto ${n}</label>
        `).join('')}</div>` : (additions.length ? '' : '<div style="font-size:.6rem;color:var(--sub);margin-bottom:4px">Sin fotos actualmente</div>')}
        ${additions.length ? `<div style="font-size:.6rem;color:var(--muted);margin-bottom:3px">Fotos añadidas pendientes de exportar: ${additions.length}</div>` : ''}
        <div style="font-size:.6rem;color:var(--muted);margin-bottom:3px">Añadir fotos:</div>
        <input type="file" accept="image/*" multiple id="photoAddInput" style="font-size:.65rem;color:var(--text);max-width:100%">
        <div id="photoPreview" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px"></div>
      </div>
      <div class="edit-actions">
        <button onclick="window.__saveEdit(${id})" class="btn btn-accent">Guardar</button>
        <span class="edit-actions-note">(solo campos modificados)</span>
        <button onclick="window.__cancelEdit()" class="btn btn-sec">Cancelar</button>
        ${hasEdits ? `<button onclick="window.__deleteEdit(${id})" class="btn btn-del" style="margin-left:auto">[Deshacer]</button>` : ''}
      </div>
    </div>
  `;

  /*---- gallery state ----*/
  window.__galList = photoList;
  window.__galIdx = 0;
  window.__galN = photoList.length;
  window.__galId = gid;
  window.__galGo = function(i) {
    if (window.__galId !== gid) return;
    window.__galIdx = i;
    const list = window.__galList || [];
    const img = document.getElementById('modal-main-img');
    if (img) {
      if (list[i]) { img.src = list[i]; img.style.display = ''; }
      else img.style.display = 'none';
    }
    document.querySelectorAll('#modal-gallery .gal-thumb').forEach((t, j) => t.classList.toggle('active', j === i));
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
  if (window.__galN) window.__galGo(0);

  if (needDetect) {
    // Detect actual base photos by preload, then apply edits
    let loaded = 0;
    const found = [];
    function onAllChecked() {
      const list = found.filter(n => !removeSet.has(n)).map(n => `images/cf_${gid}_${n}.jpg`);
      for (const a of additions) list.push(a.data);
      window.__galList = list;
      window.__galId = gid;
      window.__galIdx = 0;
      window.__galN = list.length;
      renderGalleryDOM(list, d.nombre);
      updateCounter();
    }
    for (let i = 1; i <= 5; i++) {
      const p = new Image();
      p.onload = () => { loaded++; found.push(i); if (loaded === 5) onAllChecked(); };
      p.onerror = () => { loaded++; if (loaded === 5) onAllChecked(); };
      p.src = `images/cf_${gid}_${i}.jpg`;
    }
  }

  modal.classList.add('show');
  modal.scrollTop = 0;
}

function buildGalleryHtml(list, nombre) {
  const thumbs = list.map((src, i) =>
    `<img src="${esc(src)}" class="gal-thumb${i===0?' active':''}" data-idx="${i}" onclick="window.__galGo(${i})">`
  ).join('');
  return `
    <button class="gal-arrow gal-prev" onclick="window.__galMove(-1)">&#9664;</button>
    <div class="gal-main-wrap">
      <img class="modal-img-inline" src="${esc(list[0])}" alt="${esc(nombre)}" id="modal-main-img" onclick="window.__galFs()">
      <div class="gal-counter" id="gal-counter" style="${list.length > 1 ? '' : 'display:none'}">1/${list.length}</div>
      <button class="gal-fs-btn" onclick="event.stopPropagation();window.__galFs()" title="Ver a pantalla completa">⛶</button>
    </div>
    <button class="gal-arrow gal-next" onclick="window.__galMove(1)">&#9654;</button>
    <div class="gal-thumbs" id="gal-thumbs">${thumbs}</div>`;
}

function renderGalleryDOM(list, nombre) {
  const wrap = document.getElementById('modal-gallery');
  if (!wrap) return;
  wrap.innerHTML = list.length ? buildGalleryHtml(list, nombre) : '<div class="gal-none">Sin fotos</div>';
}

/* ---------- Side Panel ---------- */
function renderSidePanel() {
  const list = $('sideList');
  const panel = $('sidePanel');
  
        const hasFilter = state.provincia || state.cuenca || state.searchTerm || state.userCoords;
  if (!hasFilter) {
    list.innerHTML = '<div style="padding:.5rem;font-size:.72rem;color:var(--sub);text-align:center">Selecciona una provincia/cuenca, busca por nombre o usa el GPS</div>';
    panel.classList.add('collapsed');
    return;
  }

  panel.classList.remove('collapsed');
  
  const maxRender = 200;
  const itemsToRender = state.filtered.slice(0, maxRender);
  
  let listHtml = itemsToRender.map(d => {
    const imgHtml = getSidePanelPhotoHTML(d.id_fuente);
      
    const distText = d._distance != null && d._distance !== Infinity 
      ? ` · <b style="color:var(--accent)">[GPS] ${d._distance.toFixed(1)} km</b>` 
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
    clearTimeout(state.fitTimer);
    state.fitTimer = setTimeout(() => {
      if (state.searchTerm && state.filtered.length) fitToFiltered();
    }, 350);
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
  const hasFilter = state.provincia || state.cuenca || state.searchTerm || state.userCoords;
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
window.__toggleAdmin = function(id) {
  if (state.adminMode) {
    deactivateAdmin();
    document.getElementById('modal').classList.remove('show');
  } else {
    showAdminLogin();
  }
};

function activateAdmin(pwd) {
  if (pwd === ADMIN_PASSWORD) {
    state.adminMode = true;
    lsSet(ADMIN_KEY, '1');
    showToast('Modo admin activado');
    return true;
  }
  showToast('Contraseña incorrecta');
  return false;
}

function deactivateAdmin() {
  state.adminMode = false;
  lsRemove(ADMIN_KEY);
  showToast('Modo admin desactivado');
}

function showAdminLogin() {
  const modal = $('modal');
  const body = $('modal-body');
  body.innerHTML = `
    <div class="modal-info" style="text-align:center;padding:1.5rem">
      <div style="font-size:2rem;margin-bottom:.5rem">[Admin]</div>
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
  initLegal();
  initSW();
  hideLoading();

  const hashId = parseInt(location.hash.match(/fuente=(\d+)/)?.[1]);
  if (hashId && state.allData.find(d => d.id_fuente === hashId)) {
    setTimeout(() => selectFuente(hashId), 400);
  }
})();

})();
