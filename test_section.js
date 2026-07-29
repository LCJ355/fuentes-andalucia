(() => {
'use strict';

const DB_NAME = 'FuentesDB';
const DB_VER = 1;
const STORE = 'fuentes';
const DATA_URL = 'fuentes_complete.json';
const DATA_JS = 'fuentes_complete.js';
const DATA_VER_KEY = 'fuentes_data_ver';
const DATA_VER = 4;
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
  favorites: (() => { try { return JSON.parse(localStorage.getItem('fuentes_favorites') || '[]'); } catch(e) { return []; })(),
  showFavoritesOnly: false,
  userCoords: null,
  userMarker: null,
  adminMode: (() => { try { return localStorage.getItem(ADMIN_KEY) === '1'; } catch(e) { return false; } })(),
};
