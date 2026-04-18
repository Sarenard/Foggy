const GRID_CELL_SIZE_METERS = 15.0;
const WEB_MERCATOR_HALF_WORLD_METERS = 20037508.342789244;
const WEB_MERCATOR_EARTH_RADIUS = 6378137.0;
const DEFAULT_DB_URL = "../location_history.db";
const CITY_WORKER_URL = "cityWorker.js";
const LEADERBOARD_TOTAL_WORKER_URL = "leaderboardTotalWorker.js";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const CITY_BOUNDARY_CACHE_KEY = "foggy.visual.cityBoundaryCache.v1";
const CITY_BOUNDARY_CACHE_LIMIT = 1000;
const CITY_BOUNDARY_MIN_REQUEST_INTERVAL_MS = 1200;
const LEADERBOARD_FETCH_TIMEOUT_MS = 8000;
const LEADERBOARD_REQUEST_SLOT_TIMEOUT_MS = 10000;

const EDIT_STATE_NORMAL = 0;
const EDIT_STATE_ADDED_BY_EDIT = 1;
const EDIT_STATE_REMOVED_BY_EDIT = 2;
const MODE_CURSOR = "cursor";
const MODE_EDIT = "edit";
const MODE_DELETE = "delete";
const MODE_BULK_EDIT = "bulk-edit";
const MODE_BULK_DELETE = "bulk-delete";
const CLEAN_HIGHLIGHT_BLINK_MS = 250;
const CLEAN_HIGHLIGHT_STYLE = {
  fill: "#ff9800",
  fillAlpha: 0.88,
  stroke: "#e65100",
  strokeAlpha: 1
};
const TIMELINE_PLAY_DURATION_MS = 12000;
const TIMELINE_END_SNAP_RATIO = 0.9995;

const basemaps = {
  cartoVoyager: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    options: {
      subdomains: "abcd",
      maxZoom: 22,
      maxNativeZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
  },
  openStreetMap: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 22,
      maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }
  },
  osmHot: {
    url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    options: {
      maxZoom: 22,
      maxNativeZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, tiles Humanitarian OpenStreetMap Team'
    }
  },
  none: null
};

let SQL;
let currentDb = null;
let currentDbLabel = "location_history.db";
let dbDirty = false;
let loadedCellsByKey = new Map();
let currentMode = MODE_CURSOR;
let cellOverlay;
let cityBoundaryLayer;
let currentBasemapLayer = null;
let currentCells = [];
let cellsByKey = new Map();
let cityBoundaryCache = loadCityBoundaryCache();
let lastBoundaryRequestAt = 0;
let cityBoundaryRequestInFlight = false;
let currentBoundaryKey = null;
let currentBoundary = null;
let cleanPreview = null;
let cleanBlinkInterval = null;
let cleanBlinkOn = false;
let timelineMinRecordedAt = null;
let timelineMaxRecordedAt = null;
let timelineCurrentRecordedAt = null;
let timelineAtEnd = true;
let timelinePlayFrame = null;
let timelineLastPlayAt = 0;
let cityWorker = null;
let cityWorkerNextRequestId = 1;
let cityWorkerTasks = new Map();
let cityBoundaryLookupId = 0;
let cityStatsRequestId = 0;
let leaderboardPresentCityKeys = new Set();
let leaderboardScanId = 0;
let leaderboardScanComplete = false;
let leaderboardScanRunning = false;
let leaderboardTotalQueue = [];
let leaderboardTotalQueuedKeys = new Set();
let leaderboardTotalInFlightKey = null;
let leaderboardTotalNextRequestId = 1;
let leaderboardTotalCalculatedKeys = new Set();

const map = L.map("map", {
  preferCanvas: true,
  zoomControl: false
}).setView([46.7, 2.5], 6);

L.control.zoom({ position: "bottomleft" }).addTo(map);
setBasemap("cartoVoyager");

cellOverlay = new FoggyCellsLayer().addTo(map);
cityBoundaryLayer = L.geoJSON(null, {
  style: {
    color: "#ff9800",
    weight: 4,
    opacity: 0.95,
    fill: false,
    lineJoin: "round"
  },
  interactive: false
}).addTo(map);

const legend = L.control({ position: "topright" });
legend.onAdd = () => {
  const node = L.DomUtil.create("div", "legend");
  node.innerHTML = `
    <div class="legend-title">Status</div>
    <div class="legend-row"><span class="swatch normal"></span><span>GPS normal</span></div>
    <div class="legend-row"><span class="swatch added"></span><span>Ajout manuel</span></div>
    <div class="legend-row"><span class="swatch removed"></span><span>Supprimé manuel</span></div>
  `;
  return node;
};
legend.addTo(map);

const editControl = L.control({ position: "topleft" });
editControl.onAdd = () => {
  const node = L.DomUtil.create("div", "legend edit-control");
  node.innerHTML = `
    <div class="legend-title">Mode</div>
    <select id="editModeSelect" aria-label="Mode d'édition">
      <option value="${MODE_CURSOR}">cursor</option>
      <option value="${MODE_EDIT}">edit</option>
      <option value="${MODE_DELETE}">delete</option>
      <option value="${MODE_BULK_EDIT}">bulk edit</option>
      <option value="${MODE_BULK_DELETE}">bulk delete</option>
    </select>
    <label class="clean-control">
      <span>Clean &lt; <strong id="cleanThresholdValue">8</strong></span>
      <input id="cleanThresholdInput" type="range" min="1" max="40" value="8">
    </label>
    <button id="cleanButton" type="button">Clean</button>
    <button id="saveDbButton" type="button">Sauver DB</button>
  `;
  L.DomEvent.disableClickPropagation(node);
  L.DomEvent.disableScrollPropagation(node);
  return node;
};
editControl.addTo(map);

const leaderboardControl = L.control({ position: "topleft" });
leaderboardControl.onAdd = () => {
  const node = L.DomUtil.create("div", "legend leaderboard-control");
  node.innerHTML = `
    <button id="leaderboardButton" type="button" title="Liste des villes visitées">Leaderboard</button>
  `;
  L.DomEvent.disableClickPropagation(node);
  L.DomEvent.disableScrollPropagation(node);
  return node;
};
leaderboardControl.addTo(map);

const dbFileInput = document.querySelector("#dbFileInput");
const basemapSelect = document.querySelector("#basemapSelect");
const loadDefaultButton = document.querySelector("#loadDefaultButton");
const fitButton = document.querySelector("#fitButton");
const mapStage = document.querySelector(".map-stage");
const statusBar = document.querySelector("#statusBar");
const cityStats = document.querySelector("#cityStats");
const cityStatsTitle = document.querySelector("#cityStatsTitle");
const cityVisitedCells = document.querySelector("#cityVisitedCells");
const cityTotalCells = document.querySelector("#cityTotalCells");
const cityPercent = document.querySelector("#cityPercent");
const cityNormalCells = document.querySelector("#cityNormalCells");
const cityAddedCells = document.querySelector("#cityAddedCells");
const cityRemovedCells = document.querySelector("#cityRemovedCells");
const totalCells = document.querySelector("#totalCells");
const normalCells = document.querySelector("#normalCells");
const addedCells = document.querySelector("#addedCells");
const removedCells = document.querySelector("#removedCells");
const editModeSelect = document.querySelector("#editModeSelect");
const cleanThresholdInput = document.querySelector("#cleanThresholdInput");
const cleanThresholdValue = document.querySelector("#cleanThresholdValue");
const cleanButton = document.querySelector("#cleanButton");
const leaderboardButton = document.querySelector("#leaderboardButton");
const leaderboardDialog = document.querySelector("#leaderboardDialog");
const leaderboardTitle = document.querySelector("#leaderboardTitle");
const leaderboardCloseButton = document.querySelector("#leaderboardCloseButton");
const leaderboardList = document.querySelector("#leaderboardList");
const leaderboardEmpty = document.querySelector("#leaderboardEmpty");
const saveDbButton = document.querySelector("#saveDbButton");
const saveSummaryDialog = document.querySelector("#saveSummaryDialog");
const saveSummaryCloseButton = document.querySelector("#saveSummaryCloseButton");
const saveSummaryCancelButton = document.querySelector("#saveSummaryCancelButton");
const saveSummaryConfirmButton = document.querySelector("#saveSummaryConfirmButton");
const summaryAddedCells = document.querySelector("#summaryAddedCells");
const summaryDeletedCells = document.querySelector("#summaryDeletedCells");
const summaryStateChangedCells = document.querySelector("#summaryStateChangedCells");
const summaryRecordedAtChangedCells = document.querySelector("#summaryRecordedAtChangedCells");
const summaryText = document.querySelector("#summaryText");
const timelineControl = document.querySelector("#timelineControl");
const timelinePlayButton = document.querySelector("#timelinePlayButton");
const timelineInput = document.querySelector("#timelineInput");
const timelineStartLabel = document.querySelector("#timelineStartLabel");
const timelineEndLabel = document.querySelector("#timelineEndLabel");
const timelineCurrentLabel = document.querySelector("#timelineCurrentLabel");

dbFileInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  setStatus(`Lecture de ${file.name}...`);
  const buffer = await file.arrayBuffer();
  loadDatabase(new Uint8Array(buffer), file.name);
});

basemapSelect.addEventListener("change", (event) => {
  setBasemap(event.target.value);
});

editModeSelect.addEventListener("change", (event) => {
  currentMode = event.target.value;
  setStatus(`Mode ${editModeLabel(currentMode)}.`);
});

cleanThresholdInput.addEventListener("input", (event) => {
  cleanThresholdValue.textContent = event.target.value;
  clearCleanPreview("Seuil modifié, aperçu clean annulé.");
});

cleanButton.addEventListener("click", () => {
  try {
    handleCleanButtonClick(Number(cleanThresholdInput.value));
  } catch (error) {
    console.error(error);
    setStatus(`Erreur pendant le clean : ${error.message}`);
  }
});

leaderboardButton.addEventListener("click", () => {
  showLeaderboard();
});

saveDbButton.addEventListener("click", () => {
  showSaveSummary();
});

leaderboardCloseButton.addEventListener("click", () => {
  hideLeaderboard();
});

saveSummaryCloseButton.addEventListener("click", () => {
  hideSaveSummary();
});

saveSummaryCancelButton.addEventListener("click", () => {
  hideSaveSummary();
});

saveSummaryConfirmButton.addEventListener("click", () => {
  hideSaveSummary();
  exportCurrentDatabase();
});

saveSummaryDialog.addEventListener("click", (event) => {
  if (event.target === saveSummaryDialog) {
    hideSaveSummary();
  }
});

leaderboardDialog.addEventListener("click", (event) => {
  if (event.target === leaderboardDialog) {
    hideLeaderboard();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !leaderboardDialog.classList.contains("is-hidden")) {
    hideLeaderboard();
    return;
  }

  if (event.key === "Escape" && !saveSummaryDialog.classList.contains("is-hidden")) {
    hideSaveSummary();
  }
});

timelineInput.addEventListener("input", (event) => {
  stopTimelinePlayback();
  setTimelineValue(Number(event.target.value));
});

timelinePlayButton.addEventListener("click", () => {
  toggleTimelinePlayback();
});

loadDefaultButton.addEventListener("click", async () => {
  try {
    setStatus(`Chargement de ${DEFAULT_DB_URL}...`);
    const response = await fetch(DEFAULT_DB_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    loadDatabase(new Uint8Array(buffer), DEFAULT_DB_URL);
  } catch (error) {
    setStatus(`Impossible de charger ${DEFAULT_DB_URL}. Lance le serveur depuis la racine du repo ou choisis un fichier .db.`);
    console.error(error);
  }
});

fitButton.addEventListener("click", () => {
  centerOnFirstRecordedCell(currentCells);
});

map.on("click", (event) => {
  if (currentMode !== MODE_CURSOR) {
    try {
      runEditModeAt(event.latlng);
    } catch (error) {
      console.error(error);
      setStatus(`Erreur pendant l'édition : ${error.message}`);
    }
    return;
  }

  const cell = latLngToGridCell(event.latlng);
  const storedCell = cellsByKey.get(cellKey(cell.column, cell.row));
  setStatus(
    storedCell
      ? plainStatusForCell(storedCell)
      : `Aucune cellule v4 ici : colonne ${cell.column}, ligne ${cell.row}.`
  );
  resolveCityBoundaryAt(event.latlng);
});

window.addEventListener("beforeunload", (event) => {
  if (!dbDirty) return;

  event.preventDefault();
  event.returnValue = "";
});

initSql();

function setBasemap(name) {
  if (currentBasemapLayer) {
    map.removeLayer(currentBasemapLayer);
    currentBasemapLayer = null;
  }

  const config = basemaps[name];
  if (!config) {
    setStatus("Fond de carte désactivé.");
    return;
  }

  currentBasemapLayer = L.tileLayer(config.url, {
    ...config.options,
    crossOrigin: true
  }).addTo(map);
}

async function resolveCityBoundaryAt(latlng) {
  restartCityWorkerForClick();
  syncCityWorkerCells(currentCells);

  const lookupId = ++cityBoundaryLookupId;
  const plainLatLng = { lat: latlng.lat, lng: latlng.lng };
  let cachedBoundary = null;

  try {
    cachedBoundary = await findCachedBoundaryContainingInWorker(plainLatLng);
  } catch (error) {
    if (error && error.isCityWorkerRestart) return;
    throw error;
  }

  if (lookupId !== cityBoundaryLookupId) return;

  if (cachedBoundary) {
    cachedBoundary.lastUsedAt = Date.now();
    saveCityBoundaryCache();
    showCityBoundary(cachedBoundary);
    return;
  }

  if (cityBoundaryRequestInFlight) {
    setStatus("Recherche de frontière déjà en cours.");
    return;
  }

  const delay = Math.max(
    0,
    CITY_BOUNDARY_MIN_REQUEST_INTERVAL_MS - (Date.now() - lastBoundaryRequestAt)
  );

  if (delay > 0) {
    setStatus("Patiente une seconde avant une nouvelle recherche de frontière.");
    return;
  }

  cityBoundaryRequestInFlight = true;
  lastBoundaryRequestAt = Date.now();

  try {
    const boundary = await fetchCityBoundary(plainLatLng);
    if (lookupId !== cityBoundaryLookupId) return;

    if (boundary) {
      showCityBoundary(boundary);
    }
  } catch (error) {
    console.error(error);
  } finally {
    cityBoundaryRequestInFlight = false;
  }
}

async function fetchCityBoundary(latlng, options = {}) {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", latlng.lat.toString());
  url.searchParams.set("lon", latlng.lng.toString());
  url.searchParams.set("zoom", "10");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("polygon_threshold", "0.0003");
  url.searchParams.set("accept-language", "fr");

  const response = await fetch(url.toString(), {
    signal: options.signal,
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) return null;

  const data = await response.json();
  const boundary = boundaryFromNominatim(data);
  if (!boundary) return null;

  const cachedBoundary = cityBoundaryCache.items[boundary.key];
  if (cachedBoundary) {
    cachedBoundary.lastUsedAt = Date.now();
    saveCityBoundaryCache();
    return cachedBoundary;
  }

  cityBoundaryCache.items[boundary.key] = boundary;
  trimCityBoundaryCache();
  saveCityBoundaryCache();
  return boundary;
}

function boundaryFromNominatim(data) {
  const geoJson = data && data.geojson;
  if (!geoJson || !["Polygon", "MultiPolygon"].includes(geoJson.type)) return null;

  const address = data.address || {};
  if (isNominatimCountryBoundary(data, address)) return null;

  const name =
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.county ||
    data.name ||
    data.display_name ||
    "Ville";
  const key = `${data.osm_type || "place"}:${data.osm_id || normalizedBoundaryName(name)}`;

  return {
    key,
    name,
    boundaryType: data.addresstype || data.type || "",
    countryCode: (address.country_code || "").toLowerCase(),
    hasLocalBoundaryName: Boolean(address.city || address.town || address.village || address.municipality || address.county),
    geoJson,
    lastUsedAt: Date.now()
  };
}

function isNominatimCountryBoundary(data, address) {
  const isLowRankAdministrativeBoundary =
    data.type === "administrative" &&
    data.category === "boundary" &&
    Number(data.place_rank) <= 4;
  const hasOnlyCountryAddress =
    address.country &&
    !address.city &&
    !address.town &&
    !address.village &&
    !address.municipality &&
    !address.county;

  return data.addresstype === "country" ||
    isLowRankAdministrativeBoundary ||
    Boolean(hasOnlyCountryAddress);
}

function showCityBoundary(boundary) {
  if (boundary.key === currentBoundaryKey) return;

  currentBoundaryKey = boundary.key;
  cityBoundaryLayer.clearLayers();
  cityBoundaryLayer.addData(boundary.geoJson);
  cityBoundaryLayer.bringToFront();
  currentBoundary = boundary;
  updateCityStats(boundary);
  setStatus(`Frontière : ${boundary.name}.`);
}

async function findCachedBoundaryContainingInWorker(latlng) {
  const boundaries = Object.values(cityBoundaryCache.items)
    .filter((boundary) => boundary && boundary.key && boundary.geoJson && isAllowedCityBoundary(boundary))
    .map((boundary) => ({
      key: boundary.key,
      geoJson: boundary.geoJson
    }));

  if (boundaries.length === 0) return null;

  try {
    const { boundaryKey } = await postCityWorkerTask("findBoundaryContaining", {
      latlng,
      boundaries
    });

    return boundaryKey ? cityBoundaryCache.items[boundaryKey] || null : null;
  } catch (error) {
    if (error && error.isCityWorkerRestart) throw error;

    console.warn("Worker ville indisponible, calcul de cache sur le thread principal.", error);
    return findCachedBoundaryContaining(latlng);
  }
}

function getCityWorker() {
  if (!("Worker" in window)) return null;
  if (cityWorker) return cityWorker;

  try {
    cityWorker = new Worker(CITY_WORKER_URL);
  } catch (error) {
    console.warn("Worker ville indisponible.", error);
    cityWorker = null;
    return null;
  }

  cityWorker.onmessage = (event) => {
    const { requestId, result, error } = event.data || {};
    const task = cityWorkerTasks.get(requestId);
    if (!task) return;

    cityWorkerTasks.delete(requestId);
    if (error) {
      task.reject(new Error(error));
      return;
    }

    task.resolve(result);
  };
  cityWorker.onerror = (event) => {
    const error = new Error(event.message || "Erreur du worker ville.");
    terminateCityWorker(error);
  };

  return cityWorker;
}

function restartCityWorkerForClick() {
  if (!cityWorker || cityWorkerTasks.size === 0) return;

  const error = new Error("Worker ville relancé pour un nouveau clic.");
  error.isCityWorkerRestart = true;
  terminateCityWorker(error);
}

function terminateCityWorker(error) {
  const worker = cityWorker;
  cityWorker = null;

  for (const task of cityWorkerTasks.values()) {
    task.reject(error);
  }

  cityWorkerTasks.clear();

  if (worker) {
    worker.terminate();
  }
}

function postCityWorkerTask(type, payload) {
  const worker = getCityWorker();
  if (!worker) {
    return Promise.reject(new Error("Web Worker indisponible."));
  }

  const requestId = cityWorkerNextRequestId;
  cityWorkerNextRequestId += 1;

  return new Promise((resolve, reject) => {
    cityWorkerTasks.set(requestId, { resolve, reject });
    worker.postMessage({ requestId, type, payload });
  });
}

function syncCityWorkerCells(cells) {
  postCityWorkerTask("setCells", { cells }).catch((error) => {
    if (error && error.isCityWorkerRestart) return;
    console.warn("Impossible de synchroniser les cellules dans le worker ville.", error);
  });
}

function loadCityBoundaryCache() {
  try {
    const rawCache = window.localStorage.getItem(CITY_BOUNDARY_CACHE_KEY);
    if (!rawCache) return { items: {} };
    const parsedCache = JSON.parse(rawCache);
    if (!parsedCache || typeof parsedCache.items !== "object") return { items: {} };
    return pruneCityBoundaryCache(parsedCache);
  } catch (_error) {
    return { items: {} };
  }
}

function pruneCityBoundaryCache(cache) {
  let changed = false;

  for (const [key, boundary] of Object.entries(cache.items)) {
    if (!isAllowedCityBoundary(boundary)) {
      delete cache.items[key];
      changed = true;
    }
  }

  if (changed) {
    try {
      window.localStorage.setItem(CITY_BOUNDARY_CACHE_KEY, JSON.stringify(cache));
    } catch (_error) {
      // The visualizer still works if browser storage is unavailable or full.
    }
  }

  return cache;
}

function saveCityBoundaryCache() {
  try {
    window.localStorage.setItem(CITY_BOUNDARY_CACHE_KEY, JSON.stringify(cityBoundaryCache));
  } catch (_error) {
    // The visualizer still works if browser storage is unavailable or full.
  }
}

function trimCityBoundaryCache() {
  const entries = Object.entries(cityBoundaryCache.items);
  if (entries.length <= CITY_BOUNDARY_CACHE_LIMIT) return;

  entries
    .sort(([, first], [, second]) => (first.lastUsedAt || 0) - (second.lastUsedAt || 0))
    .slice(0, entries.length - CITY_BOUNDARY_CACHE_LIMIT)
    .forEach(([key]) => {
      delete cityBoundaryCache.items[key];
    });
}

function clearCachedCityStats() {
  let changed = false;

  for (const boundary of Object.values(cityBoundaryCache.items)) {
    if (boundary && boundary.stats) {
      delete boundary.stats;
      changed = true;
    }
  }

  if (changed) {
    saveCityBoundaryCache();
  }
}

function invalidateCachedCityStatsForCells(cells) {
  if (!Array.isArray(cells) || cells.length === 0) return;

  let changed = false;
  const centers = cells.map(cellToCenterLatLng);

  for (const boundary of Object.values(cityBoundaryCache.items)) {
    if (!boundary || !boundary.stats || !boundary.geoJson || !isAllowedCityBoundary(boundary)) continue;

    const containsChangedCell = centers.some((center) => isLatLngInsideGeoJson(center, boundary.geoJson));
    if (!containsChangedCell) continue;

    delete boundary.stats;
    changed = true;
  }

  if (changed) {
    saveCityBoundaryCache();
  }
}

function findCachedBoundaryContaining(latlng) {
  for (const boundary of Object.values(cityBoundaryCache.items)) {
    if (
      boundary &&
      boundary.geoJson &&
      isAllowedCityBoundary(boundary) &&
      isLatLngInsideGeoJson(latlng, boundary.geoJson)
    ) {
      return boundary;
    }
  }

  return null;
}

function isAllowedCityBoundary(boundary) {
  if (!boundary) return false;
  const name = normalizedBoundaryName(boundary && boundary.name ? boundary.name : "");
  if (boundary.boundaryType === "country") return false;
  if (boundary.hasLocalBoundaryName === false) return false;
  if (name === "france" || name === "republique francaise") return false;
  return true;
}

function isLatLngInsideGeoJson(latlng, geoJson) {
  if (geoJson.type === "Polygon") {
    return isLatLngInsidePolygonCoordinates(latlng, geoJson.coordinates);
  }

  if (geoJson.type === "MultiPolygon") {
    return geoJson.coordinates.some((polygon) => isLatLngInsidePolygonCoordinates(latlng, polygon));
  }

  return false;
}

function countGridCellsInsideGeoJson(geoJson) {
  const projectedPolygons = projectGeoJsonToMercatorPolygons(geoJson);
  const bounds = computeProjectedBounds(projectedPolygons);
  if (!bounds) return 0;

  const minColumn = Math.floor(bounds.minX / GRID_CELL_SIZE_METERS);
  const maxColumn = Math.ceil(bounds.maxX / GRID_CELL_SIZE_METERS);
  const minRow = Math.floor(bounds.minY / GRID_CELL_SIZE_METERS);
  const maxRow = Math.ceil(bounds.maxY / GRID_CELL_SIZE_METERS);
  let total = 0;

  for (let column = minColumn; column <= maxColumn; column += 1) {
    const centerX = (column + 0.5) * GRID_CELL_SIZE_METERS;

    for (let row = minRow; row <= maxRow; row += 1) {
      const centerY = (row + 0.5) * GRID_CELL_SIZE_METERS;

      if (isProjectedPointInsidePolygons({ x: centerX, y: centerY }, projectedPolygons)) {
        total += 1;
      }
    }
  }

  return total;
}

function projectGeoJsonToMercatorPolygons(geoJson) {
  if (geoJson.type === "Polygon") {
    return [projectPolygonCoordinatesToMercator(geoJson.coordinates)];
  }

  if (geoJson.type === "MultiPolygon") {
    return geoJson.coordinates.map(projectPolygonCoordinatesToMercator);
  }

  return [];
}

function projectPolygonCoordinatesToMercator(polygonCoordinates) {
  return polygonCoordinates.map((ring) =>
    ring.map(([longitude, latitude]) => ({
      x: longitudeToWebMercatorX(Number(longitude)),
      y: latitudeToWebMercatorY(Number(latitude))
    }))
  );
}

function computeProjectedBounds(projectedPolygons) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const polygon of projectedPolygons) {
    const outerRing = polygon[0] || [];
    for (const point of outerRing) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return null;
  }

  return { minX, maxX, minY, maxY };
}

function isProjectedPointInsidePolygons(point, projectedPolygons) {
  return projectedPolygons.some((polygon) => isProjectedPointInsidePolygon(point, polygon));
}

function isProjectedPointInsidePolygon(point, polygon) {
  const outerRing = polygon[0] || [];
  if (!isProjectedPointInsideRing(point, outerRing)) return false;

  const holes = polygon.slice(1);
  return holes.every((hole) => !isProjectedPointInsideRing(point, hole));
}

function isProjectedPointInsideRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;

  let inside = false;
  let previousIndex = ring.length - 1;

  for (let currentIndex = 0; currentIndex < ring.length; currentIndex += 1) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    const crosses =
      (current.y > point.y) !== (previous.y > point.y) &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / ((previous.y - current.y) || 1e-9) + current.x;

    if (crosses) {
      inside = !inside;
    }

    previousIndex = currentIndex;
  }

  return inside;
}

function isLatLngInsidePolygonCoordinates(latlng, polygonCoordinates) {
  if (!Array.isArray(polygonCoordinates) || polygonCoordinates.length === 0) return false;

  const outerRing = polygonCoordinates[0];
  if (!isLatLngInsideRing(latlng, outerRing)) return false;

  const holes = polygonCoordinates.slice(1);
  return holes.every((hole) => !isLatLngInsideRing(latlng, hole));
}

function isLatLngInsideRing(latlng, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;

  let inside = false;
  const x = latlng.lng;
  const y = latlng.lat;
  let previousIndex = ring.length - 1;

  for (let currentIndex = 0; currentIndex < ring.length; currentIndex += 1) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    const currentX = Number(current[0]);
    const currentY = Number(current[1]);
    const previousX = Number(previous[0]);
    const previousY = Number(previous[1]);
    const crosses =
      (currentY > y) !== (previousY > y) &&
      x < ((previousX - currentX) * (y - currentY)) / ((previousY - currentY) || 1e-9) + currentX;

    if (crosses) {
      inside = !inside;
    }

    previousIndex = currentIndex;
  }

  return inside;
}

function normalizedBoundaryName(name) {
  return String(name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function FoggyCellsLayer() {
  const Layer = L.Layer.extend({
    onAdd(mapInstance) {
      this._map = mapInstance;
      this._canvas = L.DomUtil.create("canvas", "foggy-cells-canvas");
      this._canvas.style.position = "absolute";
      this._canvas.style.pointerEvents = "none";
      this._ctx = this._canvas.getContext("2d");
      this._isZooming = false;
      mapInstance.getPanes().overlayPane.appendChild(this._canvas);

      mapInstance.on("zoomstart", this._handleZoomStart, this);
      mapInstance.on("zoomend", this._handleZoomEnd, this);
      mapInstance.on("moveend resize viewreset", this._reset, this);
      this._reset();
    },

    onRemove(mapInstance) {
      L.DomUtil.remove(this._canvas);
      mapInstance.off("zoomstart", this._handleZoomStart, this);
      mapInstance.off("zoomend", this._handleZoomEnd, this);
      mapInstance.off("moveend resize viewreset", this._reset, this);
    },

    setCells(cells) {
      this._normalCells = cells.filter((cell) => cell.editState === EDIT_STATE_NORMAL);
      this._editedCells = cells.filter((cell) => cell.editState !== EDIT_STATE_NORMAL);
      this._reset();
    },

    setHighlight(cellKeys, enabled) {
      this._highlightCellKeys = cellKeys;
      this._highlightEnabled = Boolean(enabled);
      this._reset();
    },

    _handleZoomStart() {
      this._isZooming = true;
      this._clear();
    },

    _handleZoomEnd() {
      this._isZooming = false;
      this._reset();
    },

    _reset() {
      if (!this._map || !this._canvas) return;

      const size = this._map.getSize();
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);

      const ratio = window.devicePixelRatio || 1;
      this._canvas.width = Math.round(size.x * ratio);
      this._canvas.height = Math.round(size.y * ratio);
      this._canvas.style.width = `${size.x}px`;
      this._canvas.style.height = `${size.y}px`;
      this._ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      this._clear(size);

      if (!this._isZooming) {
        this._draw(size);
      }
    },

    _draw(size) {
      this._drawCells(this._normalCells || []);
      this._drawCells(this._editedCells || []);
    },

    _clear(size = this._map && this._map.getSize()) {
      if (!this._ctx || !size) return;
      this._ctx.clearRect(0, 0, size.x, size.y);
    },

    _drawCells(cells) {
      const visibleBounds = this._map.getBounds().pad(0.05);

      for (const cell of cells) {
        const bounds = cellToLatLngBounds(cell);
        if (!visibleBounds.intersects(bounds)) continue;

        const topLeft = this._map.latLngToContainerPoint(bounds.getNorthWest());
        const bottomRight = this._map.latLngToContainerPoint(bounds.getSouthEast());
        const left = Math.min(topLeft.x, bottomRight.x);
        const top = Math.min(topLeft.y, bottomRight.y);
        const width = Math.max(1, Math.abs(bottomRight.x - topLeft.x));
        const height = Math.max(1, Math.abs(bottomRight.y - topLeft.y));
        const style = this._styleForCell(cell);

        this._ctx.globalAlpha = style.fillAlpha;
        this._ctx.fillStyle = style.fill;
        this._ctx.fillRect(left, top, width, height);

        if (width >= 4 && height >= 4) {
          this._ctx.globalAlpha = style.strokeAlpha;
          this._ctx.strokeStyle = style.stroke;
          this._ctx.lineWidth = 1;
          this._ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
        }
      }

      this._ctx.globalAlpha = 1;
    },

    _styleForCell(cell) {
      const key = cellKey(cell.column, cell.row);
      if (this._highlightEnabled && this._highlightCellKeys && this._highlightCellKeys.has(key)) {
        return CLEAN_HIGHLIGHT_STYLE;
      }

      return canvasStyleForState(cell.editState);
    }
  });

  return new Layer();
}

async function initSql() {
  setStatus("Initialisation SQLite...");
  SQL = await initSqlJs({
    locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
  });
  setStatus("Prêt à charger une base v4.");
}

function loadDatabase(bytes, label) {
  if (!SQL) {
    setStatus("SQLite n'est pas encore prêt, réessaie dans une seconde.");
    return;
  }

  try {
    const nextDb = new SQL.Database(bytes);
    assertV4Schema(nextDb);
    const cells = readCells(nextDb);

    if (currentDb) {
      currentDb.close();
    }

    currentDb = nextDb;
    currentDbLabel = label || "location_history.db";
    dbDirty = false;
    loadedCellsByKey = mapCellsByKey(cells);
    resetLeaderboardPresence();
    clearCachedCityStats();
    clearCleanPreview();
    resetTimeline(cells);

    renderCells(cells);
    updateStats(cells);
    centerOnFirstRecordedCell(cells);
    setStatus(`${formatNumber(cells.length)} cellules chargées depuis ${label}.`);
  } catch (error) {
    setStatus(`Base illisible ou hors format v4 : ${error.message}`);
    console.error(error);
  }
}

function refreshFromCurrentDatabase() {
  if (!currentDb) return;

  const wasTimelineAtEnd = timelineAtEnd;
  const cells = readCells(currentDb);
  updateTimelineRange(cells, wasTimelineAtEnd);
  renderCells(cells);
  updateStats(cells);
}

function runEditModeAt(latlng) {
  if (!currentDb) {
    setStatus("Charge une DB avant d'éditer.");
    return;
  }

  clearCleanPreview();
  const recordedAt = Date.now();
  const targetCells = currentMode === MODE_BULK_EDIT || currentMode === MODE_BULK_DELETE
    ? revealedCellsAround(latlng)
    : [latLngToGridCell(latlng)];

  currentDb.run("BEGIN TRANSACTION");
  try {
    for (const cell of targetCells) {
      if (currentMode === MODE_EDIT || currentMode === MODE_BULK_EDIT) {
        applyEditInsertion(cell, recordedAt);
      } else if (currentMode === MODE_DELETE || currentMode === MODE_BULK_DELETE) {
        applyEditDeletion(cell);
      }
    }
    currentDb.run("COMMIT");
  } catch (error) {
    currentDb.run("ROLLBACK");
    throw error;
  }

  dbDirty = true;
  resetLeaderboardPresence();
  invalidateCachedCityStatsForCells(targetCells);
  refreshFromCurrentDatabase();
  setStatus(`${editModeLabel(currentMode)} : ${formatNumber(targetCells.length)} case(s) traitée(s). Sauvegarde la DB pour persister.`);
}

function applyEditInsertion(cell, recordedAt) {
  const existingEditState = getExistingEditState(cell);

  if (existingEditState === null) {
    insertGridCell(cell, recordedAt, EDIT_STATE_ADDED_BY_EDIT);
  } else if (existingEditState === EDIT_STATE_REMOVED_BY_EDIT) {
    updateCell(cell, recordedAt, EDIT_STATE_NORMAL);
  }
}

function applyEditDeletion(cell) {
  const existingEditState = getExistingEditState(cell);

  if (existingEditState === EDIT_STATE_NORMAL) {
    updateCellEditState(cell, EDIT_STATE_REMOVED_BY_EDIT);
  } else if (existingEditState === EDIT_STATE_ADDED_BY_EDIT) {
    deleteCell(cell);
  }
}

function getExistingEditState(cell) {
  const statement = currentDb.prepare(`
    SELECT edit_state
    FROM gps_points
    WHERE grid_column = ? AND grid_row = ?
    LIMIT 1
  `);

  try {
    statement.bind([cell.column, cell.row]);
    if (!statement.step()) return null;
    return Number(statement.get()[0]);
  } finally {
    statement.free();
  }
}

function insertGridCell(cell, recordedAt, editState) {
  const statement = currentDb.prepare(`
    INSERT OR REPLACE INTO gps_points (grid_column, grid_row, recorded_at, edit_state)
    VALUES (?, ?, ?, ?)
  `);

  try {
    statement.run([cell.column, cell.row, recordedAt, editState]);
  } finally {
    statement.free();
  }
}

function updateCell(cell, recordedAt, editState) {
  const statement = currentDb.prepare(`
    UPDATE gps_points
    SET recorded_at = ?, edit_state = ?
    WHERE grid_column = ? AND grid_row = ?
  `);

  try {
    statement.run([recordedAt, editState, cell.column, cell.row]);
  } finally {
    statement.free();
  }
}

function updateCellEditState(cell, editState) {
  const statement = currentDb.prepare(`
    UPDATE gps_points
    SET edit_state = ?
    WHERE grid_column = ? AND grid_row = ?
  `);

  try {
    statement.run([editState, cell.column, cell.row]);
  } finally {
    statement.free();
  }
}

function deleteCell(cell) {
  const statement = currentDb.prepare(`
    DELETE FROM gps_points
    WHERE grid_column = ? AND grid_row = ?
  `);

  try {
    statement.run([cell.column, cell.row]);
  } finally {
    statement.free();
  }
}

function handleCleanButtonClick(threshold) {
  const normalizedThreshold = normalizeCleanThreshold(threshold);
  if (
    cleanPreview &&
    cleanPreview.threshold === normalizedThreshold &&
    cleanPreview.cells.length > 0
  ) {
    cleanSmallComponents(cleanPreview.threshold, cleanPreview.cells);
    return;
  }

  previewSmallComponents(normalizedThreshold);
}

function previewSmallComponents(threshold) {
  if (!currentDb) {
    setStatus("Charge une DB avant de nettoyer.");
    return;
  }

  const cellsToDelete = getCleanCandidateCells(threshold);

  if (cellsToDelete.length === 0) {
    clearCleanPreview();
    setStatus(`Clean < ${threshold} : aucune case à supprimer.`);
    return;
  }

  setCleanPreview(threshold, cellsToDelete);
  setStatus(`Aperçu clean < ${threshold} : ${formatNumber(cellsToDelete.length)} case(s) vont changer. Reclique sur Clean pour appliquer.`);
}

function cleanSmallComponents(threshold, cellsToDelete = getCleanCandidateCells(threshold)) {
  if (!currentDb) {
    setStatus("Charge une DB avant de nettoyer.");
    return;
  }

  if (cellsToDelete.length === 0) {
    clearCleanPreview();
    setStatus(`Clean < ${threshold} : aucune case à supprimer.`);
    return;
  }

  currentDb.run("BEGIN TRANSACTION");
  try {
    for (const cell of cellsToDelete) {
      applyEditDeletion(cell);
    }
    currentDb.run("COMMIT");
  } catch (error) {
    currentDb.run("ROLLBACK");
    throw error;
  }

  dbDirty = true;
  resetLeaderboardPresence();
  invalidateCachedCityStatsForCells(cellsToDelete);
  clearCleanPreview();
  refreshFromCurrentDatabase();
  setStatus(`Clean < ${threshold} : ${formatNumber(cellsToDelete.length)} case(s) nettoyée(s). Sauvegarde la DB pour persister.`);
}

function getCleanCandidateCells(threshold) {
  const normalizedThreshold = normalizeCleanThreshold(threshold);
  const activeCells = currentCells.filter((cell) => cell.editState !== EDIT_STATE_REMOVED_BY_EDIT);
  if (activeCells.length === 0) return [];

  const { componentSizes, unionFind } = buildConnectedComponents(activeCells);
  return activeCells.filter((cell, index) => {
    const root = unionFind.find(index);
    return componentSizes.get(root) < normalizedThreshold;
  });
}

function normalizeCleanThreshold(threshold) {
  return Math.max(1, Math.min(40, Math.floor(threshold)));
}

function setCleanPreview(threshold, cells) {
  clearCleanPreview();
  cleanPreview = {
    threshold,
    cells,
    cellKeys: new Set(cells.map((cell) => cellKey(cell.column, cell.row)))
  };
  cleanBlinkOn = true;
  cleanButton.textContent = "Appliquer clean";
  cleanButton.classList.add("is-previewing");
  cellOverlay.setHighlight(cleanPreview.cellKeys, cleanBlinkOn);

  cleanBlinkInterval = window.setInterval(() => {
    cleanBlinkOn = !cleanBlinkOn;
    cellOverlay.setHighlight(cleanPreview ? cleanPreview.cellKeys : null, cleanBlinkOn);
  }, CLEAN_HIGHLIGHT_BLINK_MS);
}

function clearCleanPreview(statusMessage) {
  const hadPreview = Boolean(cleanPreview);

  if (cleanBlinkInterval) {
    window.clearInterval(cleanBlinkInterval);
    cleanBlinkInterval = null;
  }

  cleanPreview = null;
  cleanBlinkOn = false;
  cleanButton.textContent = "Clean";
  cleanButton.classList.remove("is-previewing");

  if (cellOverlay) {
    cellOverlay.setHighlight(null, false);
  }

  if (statusMessage && hadPreview) {
    setStatus(statusMessage);
  }
}

function resetTimeline(cells) {
  stopTimelinePlayback();
  updateTimelineRange(cells, true);
}

function updateTimelineRange(cells, snapToEnd) {
  let minRecordedAt = Infinity;
  let maxRecordedAt = -Infinity;

  for (const cell of cells) {
    if (!Number.isFinite(cell.recordedAt)) continue;
    minRecordedAt = Math.min(minRecordedAt, cell.recordedAt);
    maxRecordedAt = Math.max(maxRecordedAt, cell.recordedAt);
  }

  if (!Number.isFinite(minRecordedAt) || !Number.isFinite(maxRecordedAt)) {
    timelineMinRecordedAt = null;
    timelineMaxRecordedAt = null;
    timelineCurrentRecordedAt = null;
    timelineAtEnd = true;
    timelineControl.classList.add("is-hidden");
    mapStage.classList.remove("has-timeline");
    timelineInput.disabled = true;
    timelinePlayButton.disabled = true;
    return;
  }

  timelineMinRecordedAt = minRecordedAt;
  timelineMaxRecordedAt = maxRecordedAt;
  timelineInput.min = String(timelineMinRecordedAt);
  timelineInput.max = String(timelineMaxRecordedAt);
  timelineStartLabel.textContent = formatTimelineDate(timelineMinRecordedAt);
  timelineEndLabel.textContent = formatTimelineDate(timelineMaxRecordedAt);
  timelineInput.disabled = timelineMinRecordedAt === timelineMaxRecordedAt;
  timelinePlayButton.disabled = timelineMinRecordedAt === timelineMaxRecordedAt;
  timelineControl.classList.remove("is-hidden");
  mapStage.classList.add("has-timeline");

  const nextValue = snapToEnd || timelineCurrentRecordedAt === null
    ? timelineMaxRecordedAt
    : Math.max(timelineMinRecordedAt, Math.min(timelineCurrentRecordedAt, timelineMaxRecordedAt));
  setTimelineValue(nextValue, { forceEnd: snapToEnd });
}

function toggleTimelinePlayback() {
  if (!isTimelineAvailable()) return;

  if (timelinePlayFrame !== null) {
    stopTimelinePlayback();
    return;
  }

  if (timelineAtEnd) {
    setTimelineValue(timelineMinRecordedAt);
  }

  timelineLastPlayAt = performance.now();
  timelinePlayButton.textContent = "Ⅱ";
  timelinePlayButton.setAttribute("aria-label", "Mettre la timeline en pause");
  timelinePlayFrame = window.requestAnimationFrame(playTimelineFrame);
}

function playTimelineFrame(now) {
  if (!isTimelineAvailable()) {
    stopTimelinePlayback();
    return;
  }

  const elapsed = Math.max(0, now - timelineLastPlayAt);
  timelineLastPlayAt = now;
  const span = timelineMaxRecordedAt - timelineMinRecordedAt;
  const increment = span * (elapsed / TIMELINE_PLAY_DURATION_MS);
  setTimelineValue((timelineCurrentRecordedAt ?? timelineMinRecordedAt) + increment);

  if (timelineAtEnd) {
    stopTimelinePlayback();
    return;
  }

  timelinePlayFrame = window.requestAnimationFrame(playTimelineFrame);
}

function stopTimelinePlayback() {
  if (timelinePlayFrame !== null) {
    window.cancelAnimationFrame(timelinePlayFrame);
    timelinePlayFrame = null;
  }

  if (timelinePlayButton) {
    timelinePlayButton.textContent = "▶";
    timelinePlayButton.setAttribute("aria-label", "Lire la timeline");
  }
}

function setTimelineValue(value, options = {}) {
  if (!isTimelineAvailable()) return;

  const span = timelineMaxRecordedAt - timelineMinRecordedAt;
  const clamped = Math.max(timelineMinRecordedAt, Math.min(Number(value), timelineMaxRecordedAt));
  const shouldSnapToEnd = options.forceEnd ||
    clamped >= timelineMaxRecordedAt ||
    (span > 0 && (clamped - timelineMinRecordedAt) / span >= TIMELINE_END_SNAP_RATIO);

  timelineAtEnd = shouldSnapToEnd;
  timelineCurrentRecordedAt = shouldSnapToEnd ? timelineMaxRecordedAt : Math.round(clamped);
  timelineInput.value = String(timelineCurrentRecordedAt);
  timelineCurrentLabel.textContent = timelineAtEnd
    ? `${formatTimelineDate(timelineMaxRecordedAt)} · fin`
    : formatTimelineDate(timelineCurrentRecordedAt);
  applyTimelineFilter();
}

function applyTimelineFilter() {
  if (!cellOverlay) return;

  cellOverlay.setCells(timelineFilteredCells());

  if (currentBoundary) {
    updateCityStats(currentBoundary);
  }
}

function timelineFilteredCells() {
  if (!isTimelineAvailable() || timelineAtEnd) return currentCells;

  return currentCells.filter((cell) =>
    Number.isFinite(cell.recordedAt) && cell.recordedAt <= timelineCurrentRecordedAt
  );
}

function isTimelineAvailable() {
  return timelineMinRecordedAt !== null &&
    timelineMaxRecordedAt !== null &&
    Number.isFinite(timelineMinRecordedAt) &&
    Number.isFinite(timelineMaxRecordedAt);
}

function buildConnectedComponents(cells) {
  const unionFind = new UnionFind(cells.length);
  const indicesByCellKey = new Map();

  cells.forEach((cell, index) => {
    indicesByCellKey.set(cellKey(cell.column, cell.row), index);
  });

  cells.forEach((cell, index) => {
    const rightNeighborIndex = indicesByCellKey.get(cellKey(cell.column + 1, cell.row));
    const topNeighborIndex = indicesByCellKey.get(cellKey(cell.column, cell.row + 1));

    if (rightNeighborIndex !== undefined) {
      unionFind.union(index, rightNeighborIndex);
    }

    if (topNeighborIndex !== undefined) {
      unionFind.union(index, topNeighborIndex);
    }
  });

  const componentSizes = new Map();
  for (let index = 0; index < cells.length; index += 1) {
    const root = unionFind.find(index);
    componentSizes.set(root, (componentSizes.get(root) || 0) + 1);
  }

  return { componentSizes, unionFind };
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_value, index) => index);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(index) {
    if (this.parent[index] !== index) {
      this.parent[index] = this.find(this.parent[index]);
    }

    return this.parent[index];
  }

  union(firstIndex, secondIndex) {
    const firstRoot = this.find(firstIndex);
    const secondRoot = this.find(secondIndex);

    if (firstRoot === secondRoot) return;

    if (this.rank[firstRoot] < this.rank[secondRoot]) {
      this.parent[firstRoot] = secondRoot;
    } else if (this.rank[firstRoot] > this.rank[secondRoot]) {
      this.parent[secondRoot] = firstRoot;
    } else {
      this.parent[secondRoot] = firstRoot;
      this.rank[firstRoot] += 1;
    }
  }
}

function exportCurrentDatabase() {
  if (!currentDb) {
    setStatus("Aucune DB à sauvegarder.");
    return;
  }

  const bytes = currentDb.export();
  const blob = new Blob([bytes], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = savedDatabaseFileName(currentDbLabel);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  dbDirty = false;
  loadedCellsByKey = mapCellsByKey(readCells(currentDb));
  setStatus("DB exportée.");
}

function showLeaderboard() {
  renderLeaderboard();
  leaderboardDialog.classList.remove("is-hidden");
  if (!leaderboardScanComplete) {
    scanLeaderboardCities().catch((error) => {
      console.error(error);
      leaderboardScanRunning = false;
      updateLeaderboardIdleTitle();
      leaderboardEmpty.textContent = "Impossible de construire la liste.";
      renderLeaderboard();
      setStatus(`Erreur leaderboard : ${error.message}`);
    });
  }
}

function hideLeaderboard() {
  leaderboardScanId += 1;
  leaderboardScanRunning = false;
  leaderboardTitle.textContent = "Villes";
  leaderboardDialog.classList.add("is-hidden");
}

function renderLeaderboard() {
  const cities = Array.from(leaderboardPresentCityKeys)
    .map((key) => cityBoundaryCache.items[key])
    .filter((boundary) => boundary && boundary.geoJson && isAllowedCityBoundary(boundary))
    .sort((first, second) => {
      const firstName = first.name || "";
      const secondName = second.name || "";
      return firstName.localeCompare(secondName, "fr", { sensitivity: "base" });
    });

  leaderboardList.replaceChildren();
  leaderboardEmpty.classList.toggle("is-hidden", cities.length > 0);

  for (const city of cities) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const total = document.createElement("strong");

    item.dataset.cityKey = city.key;
    name.textContent = city.name || "Ville";
    total.textContent = Number.isFinite(city.totalGridCells)
      ? `0/${formatNumber(city.totalGridCells)}`
      : "0/...";
    item.append(name, total);
    leaderboardList.append(item);

    if (!leaderboardTotalCalculatedKeys.has(city.key)) {
      enqueueLeaderboardTotal(city.key);
    }
  }
}

function resetLeaderboardPresence() {
  leaderboardPresentCityKeys = new Set();
  leaderboardScanId += 1;
  leaderboardScanComplete = false;
  leaderboardScanRunning = false;
  resetLeaderboardTotalQueue();
}

function resetLeaderboardTotalQueue() {
  leaderboardTotalQueue = [];
  leaderboardTotalQueuedKeys = new Set();
  leaderboardTotalInFlightKey = null;
  leaderboardTotalCalculatedKeys = new Set();
}

function enqueueLeaderboardTotal(cityKey) {
  if (!cityKey || leaderboardTotalQueuedKeys.has(cityKey) || leaderboardTotalInFlightKey === cityKey) return;

  leaderboardTotalQueue.push(cityKey);
  leaderboardTotalQueuedKeys.add(cityKey);
  processNextLeaderboardTotal();
}

async function processNextLeaderboardTotal() {
  if (leaderboardTotalInFlightKey || leaderboardTotalQueue.length === 0) return;

  const cityKey = leaderboardTotalQueue.shift();
  leaderboardTotalQueuedKeys.delete(cityKey);
  const boundary = cityBoundaryCache.items[cityKey];

  if (!boundary || !boundary.geoJson || !isAllowedCityBoundary(boundary)) {
    processNextLeaderboardTotal();
    return;
  }

  leaderboardTotalInFlightKey = cityKey;
  updateLeaderboardTotalRow(cityKey, "0/...");

  try {
    const totalGridCells = await countLeaderboardTotalInWorker(boundary.geoJson);
    if (!Number.isFinite(totalGridCells)) return;

    leaderboardTotalCalculatedKeys.add(cityKey);
    boundary.totalGridCells = totalGridCells;
    if (boundary.stats) {
      boundary.stats.total = totalGridCells;
      boundary.stats.percent = totalGridCells > 0
        ? (100.0 * (boundary.stats.visited || 0)) / totalGridCells
        : 0;
    }
    boundary.lastUsedAt = Date.now();
    cityBoundaryCache.items[boundary.key] = boundary;
    saveCityBoundaryCache();
    updateLeaderboardTotalRow(cityKey, `0/${formatNumber(totalGridCells)}`);
  } catch (error) {
    console.error(error);
    updateLeaderboardTotalRow(cityKey, "0/...");
  } finally {
    leaderboardTotalInFlightKey = null;
    processNextLeaderboardTotal();
    updateLeaderboardIdleTitle();
  }
}

function countLeaderboardTotalInWorker(geoJson) {
  if (!("Worker" in window)) {
    return Promise.resolve(countGridCellsInsideGeoJson(geoJson));
  }

  const requestId = leaderboardTotalNextRequestId;
  leaderboardTotalNextRequestId += 1;

  return new Promise((resolve, reject) => {
    let worker;

    try {
      worker = new Worker(LEADERBOARD_TOTAL_WORKER_URL);
    } catch (error) {
      resolve(countGridCellsInsideGeoJson(geoJson));
      return;
    }

    worker.onmessage = (event) => {
      const { requestId: responseRequestId, totalGridCells, error } = event.data || {};
      if (responseRequestId !== requestId) return;

      worker.terminate();
      if (error) {
        reject(new Error(error));
        return;
      }

      resolve(totalGridCells);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Erreur du worker leaderboard."));
    };
    worker.postMessage({ requestId, geoJson });
  });
}

function updateLeaderboardTotalRow(cityKey, value) {
  const row = Array.from(leaderboardList.children).find((item) => item.dataset.cityKey === cityKey);
  if (!row) return;

  const total = row.querySelector("strong");
  if (total) {
    total.textContent = value;
  }
}

async function scanLeaderboardCities() {
  leaderboardScanRunning = true;
  updateLeaderboardScanTitle(0, 0);

  if (!currentCells.length) {
    leaderboardEmpty.textContent = "Aucune ville visitée.";
    renderLeaderboard();
    leaderboardScanComplete = true;
    leaderboardScanRunning = false;
    updateLeaderboardIdleTitle();
    return;
  }

  const scanId = ++leaderboardScanId;
  let cacheScanIndex = 0;
  const missingCellIndexes = [];
  const activeCells = currentCells.filter((cell) => cell.editState !== EDIT_STATE_REMOVED_BY_EDIT);
  leaderboardEmpty.textContent = "Analyse des cellules...";
  renderLeaderboard();
  syncCityWorkerCells(currentCells);

  while (scanId === leaderboardScanId) {
    const result = await scanLeaderboardCachedBatchInWorker(cacheScanIndex);
    if (scanId !== leaderboardScanId) return;

    addLeaderboardBoundaryKeys(result.boundaryKeys);
    missingCellIndexes.push(...result.missingCellIndexes);
    cacheScanIndex = result.nextIndex;
    updateLeaderboardScanTitle(result.processed, result.total);
    renderLeaderboard();

    if (result.done) {
      break;
    }
  }

  for (let missingIndex = 0; missingIndex < missingCellIndexes.length; missingIndex += 1) {
    if (scanId !== leaderboardScanId) return;

    const cellIndex = missingCellIndexes[missingIndex];
    const center = cellToCenterLatLng(activeCells[cellIndex]);
    const latlng = { lat: center.lat, lng: center.lng };
    let boundary = null;

    try {
      boundary = await findCachedBoundaryContainingInWorker(latlng);
    } catch (error) {
      if (error && error.isCityWorkerRestart) {
        boundary = findCachedBoundaryContaining(latlng);
      } else {
        throw error;
      }
    }

    if (boundary && isAllowedCityBoundary(boundary)) {
      leaderboardPresentCityKeys.add(boundary.key);
      renderLeaderboard();
      continue;
    }

    updateLeaderboardResolvingTitle(missingIndex, missingCellIndexes.length);
    boundary = await fetchCityBoundaryForLeaderboard(latlng, scanId);
    if (scanId !== leaderboardScanId) return;

    if (
      boundary &&
      isAllowedCityBoundary(boundary) &&
      isLatLngInsideGeoJson(latlng, boundary.geoJson)
    ) {
      leaderboardPresentCityKeys.add(boundary.key);
      boundary.lastUsedAt = Date.now();
      cityBoundaryCache.items[boundary.key] = boundary;
      saveCityBoundaryCache();
      renderLeaderboard();
      continue;
    }

    if (boundary && isAllowedCityBoundary(boundary)) {
      console.warn("Leaderboard : frontière ignorée car elle ne contient pas la cellule demandée.", boundary.name);
    }
  }

  leaderboardScanComplete = true;
  leaderboardScanRunning = false;
  leaderboardEmpty.textContent = "Aucune ville visitée.";
  renderLeaderboard();
  updateLeaderboardIdleTitle();
}

function scanLeaderboardCachedBatchInWorker(startIndex) {
  return postCityWorkerTask("scanLeaderboardCachedBatch", {
    startIndex,
    batchSize: 1000,
    presentBoundaries: leaderboardBoundaryPayload(Array.from(leaderboardPresentCityKeys)),
    cacheBoundaries: leaderboardBoundaryPayload(Object.keys(cityBoundaryCache.items))
  });
}

function addLeaderboardBoundaryKeys(boundaryKeys) {
  if (!Array.isArray(boundaryKeys)) return;

  for (const key of boundaryKeys) {
    if (cityBoundaryCache.items[key]) {
      leaderboardPresentCityKeys.add(key);
    }
  }
}

function leaderboardBoundaryPayload(keys) {
  return keys
    .map((key) => cityBoundaryCache.items[key])
    .filter((boundary) => boundary && boundary.key && boundary.geoJson && isAllowedCityBoundary(boundary))
    .map((boundary) => ({
      key: boundary.key,
      geoJson: boundary.geoJson
    }));
}

function updateLeaderboardScanTitle(processed, total, suffix = "") {
  const progress = total > 0
    ? `${formatNumber(processed)}/${formatNumber(total)}`
    : "0/0";
  leaderboardTitle.textContent = suffix
    ? `Recherche des villes en cours... ${progress} (${suffix})`
    : `Recherche des villes en cours... ${progress}`;
}

function updateLeaderboardResolvingTitle(resolved, total) {
  const progress = total > 0
    ? `${formatNumber(resolved)}/${formatNumber(total)}`
    : "0/0";
  leaderboardTitle.textContent = `Résolution des villes manquantes via Nominatim... ${progress} cellules`;
}

function updateLeaderboardIdleTitle() {
  if (
    leaderboardScanRunning ||
    leaderboardTotalInFlightKey ||
    leaderboardTotalQueue.length > 0 ||
    leaderboardTotalQueuedKeys.size > 0
  ) {
    return;
  }

  leaderboardTitle.textContent = "Villes";
}

async function fetchCityBoundaryForLeaderboard(latlng, scanId) {
  const slotWaitStartedAt = Date.now();

  while (cityBoundaryRequestInFlight) {
    if (scanId !== leaderboardScanId) return null;
    if (Date.now() - slotWaitStartedAt >= LEADERBOARD_REQUEST_SLOT_TIMEOUT_MS) {
      console.warn("Leaderboard : attente de requête ville trop longue, cellule ignorée.");
      return null;
    }
    await sleep(250);
  }

  const delay = Math.max(
    0,
    CITY_BOUNDARY_MIN_REQUEST_INTERVAL_MS - (Date.now() - lastBoundaryRequestAt)
  );

  if (delay > 0) {
    await sleep(delay);
  }

  if (scanId !== leaderboardScanId) return null;

  cityBoundaryRequestInFlight = true;
  lastBoundaryRequestAt = Date.now();

  try {
    return await fetchCityBoundaryWithTimeout(latlng, LEADERBOARD_FETCH_TIMEOUT_MS);
  } catch (error) {
    console.error(error);
    return null;
  } finally {
    cityBoundaryRequestInFlight = false;
  }
}

function sleep(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function fetchCityBoundaryWithTimeout(latlng, timeoutMs) {
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      controller.abort();
      reject(new Error("Recherche ville trop longue."));
    }, timeoutMs);

    fetchCityBoundary(latlng, { signal: controller.signal })
      .then(resolve, reject)
      .finally(() => {
        window.clearTimeout(timeoutId);
      });
  });
}

function showSaveSummary() {
  if (!currentDb) {
    setStatus("Aucune DB à sauvegarder.");
    return;
  }

  clearCleanPreview();
  const summary = computeChangeSummary();
  updateSaveSummary(summary);
  saveSummaryDialog.classList.remove("is-hidden");
  saveSummaryConfirmButton.focus();
}

function hideSaveSummary() {
  saveSummaryDialog.classList.add("is-hidden");
}

function updateSaveSummary(summary) {
  summaryAddedCells.textContent = formatNumber(summary.added);
  summaryDeletedCells.textContent = formatNumber(summary.deleted);
  summaryStateChangedCells.textContent = formatNumber(summary.stateChanged);
  summaryRecordedAtChangedCells.textContent = formatNumber(summary.recordedAtChanged);

  if (summary.totalChanged === 0) {
    summaryText.textContent = "Aucun changement détecté depuis le chargement de cette DB.";
    saveSummaryConfirmButton.textContent = "Exporter quand même";
    return;
  }

  summaryText.textContent = `${formatNumber(summary.totalChanged)} cellule(s) différente(s) depuis le chargement. Le fichier exporté contiendra l'état courant affiché sur la carte.`;
  saveSummaryConfirmButton.textContent = "Exporter DB";
}

function computeChangeSummary() {
  const currentCellsByKey = mapCellsByKey(currentCells);
  let added = 0;
  let deleted = 0;
  let stateChanged = 0;
  let recordedAtChanged = 0;
  const changedKeys = new Set();

  for (const [key, cell] of currentCellsByKey.entries()) {
    const loadedCell = loadedCellsByKey.get(key);
    if (!loadedCell) {
      added += 1;
      changedKeys.add(key);
      continue;
    }

    if (loadedCell.editState !== cell.editState) {
      stateChanged += 1;
      changedKeys.add(key);
    }

    if (loadedCell.recordedAt !== cell.recordedAt) {
      recordedAtChanged += 1;
      changedKeys.add(key);
    }
  }

  for (const key of loadedCellsByKey.keys()) {
    if (!currentCellsByKey.has(key)) {
      deleted += 1;
      changedKeys.add(key);
    }
  }

  return {
    added,
    deleted,
    stateChanged,
    recordedAtChanged,
    totalChanged: changedKeys.size
  };
}

function mapCellsByKey(cells) {
  const mappedCells = new Map();

  for (const cell of cells) {
    mappedCells.set(cellKey(cell.column, cell.row), {
      column: cell.column,
      row: cell.row,
      recordedAt: cell.recordedAt,
      editState: cell.editState
    });
  }

  return mappedCells;
}

function savedDatabaseFileName(label) {
  const baseName = String(label || "location_history.db").split("/").pop() || "location_history.db";
  return baseName.endsWith(".db")
    ? baseName.replace(/\.db$/, ".edited.db")
    : `${baseName}.edited.db`;
}

function editModeLabel(mode) {
  return {
    [MODE_CURSOR]: "cursor",
    [MODE_EDIT]: "edit",
    [MODE_DELETE]: "delete",
    [MODE_BULK_EDIT]: "bulk edit",
    [MODE_BULK_DELETE]: "bulk delete"
  }[mode] || mode;
}

function assertV4Schema(db) {
  const requiredColumns = new Set(["grid_column", "grid_row", "recorded_at", "edit_state"]);
  const result = db.exec("PRAGMA table_info(gps_points)");
  if (result.length === 0) {
    throw new Error("table gps_points absente");
  }

  const nameIndex = result[0].columns.indexOf("name");
  const columns = result[0].values.map((row) => row[nameIndex]);
  for (const column of requiredColumns) {
    if (!columns.includes(column)) {
      throw new Error(`colonne ${column} absente`);
    }
  }
}

function readCells(db) {
  const result = db.exec(`
    SELECT grid_column, grid_row, recorded_at, edit_state
    FROM gps_points
    ORDER BY recorded_at ASC
  `);

  if (result.length === 0) return [];

  return result[0].values.map(([column, row, recordedAt, editState]) => ({
    column: Number(column),
    row: Number(row),
    recordedAt: Number(recordedAt),
    editState: Number(editState)
  }));
}

function renderCells(cells) {
  currentCells = cells;
  syncCityWorkerCells(cells);
  cellsByKey = new Map();

  for (const cell of cells) {
    cellsByKey.set(cellKey(cell.column, cell.row), cell);
  }

  applyTimelineFilter();

  if (currentBoundary) {
    updateCityStats(currentBoundary);
  }
}

function cellToLatLngBounds(cell) {
  const left = cell.column * GRID_CELL_SIZE_METERS;
  const right = left + GRID_CELL_SIZE_METERS;
  const top = cell.row * GRID_CELL_SIZE_METERS;
  const bottom = top + GRID_CELL_SIZE_METERS;

  const north = webMercatorYToLatitude(bottom);
  const south = webMercatorYToLatitude(top);
  const west = webMercatorXToLongitude(left);
  const east = webMercatorXToLongitude(right);

  return L.latLngBounds([south, west], [north, east]);
}

function cellToCenterLatLng(cell) {
  const centerX = (cell.column + 0.5) * GRID_CELL_SIZE_METERS;
  const centerY = (cell.row + 0.5) * GRID_CELL_SIZE_METERS;

  return L.latLng(
    webMercatorYToLatitude(centerY),
    webMercatorXToLongitude(centerX)
  );
}

function canvasStyleForState(editState) {
  if (editState === EDIT_STATE_ADDED_BY_EDIT) {
    return {
      fill: "#4caf50",
      fillAlpha: 0.67,
      stroke: "#2e7d32",
      strokeAlpha: 0.92
    };
  }

  if (editState === EDIT_STATE_REMOVED_BY_EDIT) {
    return {
      fill: "#d32f2f",
      fillAlpha: 0.67,
      stroke: "#9f1f1f",
      strokeAlpha: 0.92
    };
  }

  return {
    fill: "#2f8dff",
    fillAlpha: 0.92,
    stroke: "#1d6fd1",
    strokeAlpha: 1
  };
}

function plainStatusForCell(cell) {
  const status = {
    [EDIT_STATE_NORMAL]: "GPS normal",
    [EDIT_STATE_ADDED_BY_EDIT]: "Ajout manuel",
    [EDIT_STATE_REMOVED_BY_EDIT]: "Suppression manuelle"
  }[cell.editState] || `Etat ${cell.editState}`;

  const date = Number.isFinite(cell.recordedAt)
    ? new Date(cell.recordedAt).toLocaleString()
    : "date inconnue";

  return `${status} : colonne ${cell.column}, ligne ${cell.row}, ${date}.`;
}

function centerOnFirstRecordedCell(cells) {
  if (cells.length === 0) {
    setStatus("Aucune cellule à centrer.");
    return;
  }

  map.setView(cellToCenterLatLng(cells[0]), 17, {
    animate: true
  });
}

function updateStats(cells) {
  const counts = new Map([
    [EDIT_STATE_NORMAL, 0],
    [EDIT_STATE_ADDED_BY_EDIT, 0],
    [EDIT_STATE_REMOVED_BY_EDIT, 0]
  ]);

  for (const cell of cells) {
    counts.set(cell.editState, (counts.get(cell.editState) || 0) + 1);
  }

  const normal = counts.get(EDIT_STATE_NORMAL) || 0;
  const added = counts.get(EDIT_STATE_ADDED_BY_EDIT) || 0;
  const removed = counts.get(EDIT_STATE_REMOVED_BY_EDIT) || 0;

  totalCells.textContent = formatNumber(normal + added);
  normalCells.textContent = formatNumber(normal);
  addedCells.textContent = formatNumber(added);
  removedCells.textContent = formatNumber(removed);
}

function updateCityStats(boundary) {
  const requestId = ++cityStatsRequestId;
  cityStatsTitle.textContent = `Ville de ${boundary.name}`;
  cityStats.classList.remove("is-hidden");

  if (isValidCachedCityStats(boundary.stats)) {
    applyCityStats(boundary, boundary.stats);
    return;
  }

  cityVisitedCells.textContent = "...";
  cityVisitedCells.dataset.value = "0";
  cityNormalCells.textContent = "...";
  cityAddedCells.textContent = "...";
  cityRemovedCells.textContent = "...";
  cityTotalCells.textContent = "...";
  cityPercent.textContent = "...";

  postCityWorkerTask("countCellsInsideBoundary", { boundary })
    .catch((error) => {
      if (error && error.isCityWorkerRestart) return null;
      return countCellsInsideBoundary(boundary);
    })
    .then(async (counts) => {
      if (!counts) return null;
      const totalGridCells = Number.isFinite(boundary.totalGridCells)
        ? boundary.totalGridCells
        : await countTotalGridCellsForBoundary(boundary);
      if (!Number.isFinite(totalGridCells)) return null;
      return buildCityStats(counts, totalGridCells);
    })
    .then((stats) => {
      if (!stats) return;
      if (requestId !== cityStatsRequestId) return;
      boundary.stats = stats;
      boundary.totalGridCells = stats.total;
      boundary.lastUsedAt = Date.now();
      cityBoundaryCache.items[boundary.key] = boundary;
      saveCityBoundaryCache();
      applyCityStats(boundary, stats);
    });
}

function countTotalGridCellsForBoundary(boundary) {
  return postCityWorkerTask("countGridCellsInsideGeoJson", { geoJson: boundary.geoJson })
    .catch((error) => {
      if (error && error.isCityWorkerRestart) return null;
      return { totalGridCells: countGridCellsInsideGeoJson(boundary.geoJson) };
    })
    .then((result) => result ? result.totalGridCells : null);
}

function countCellsInsideBoundary(boundary) {
  const counts = new Map([
    [EDIT_STATE_NORMAL, 0],
    [EDIT_STATE_ADDED_BY_EDIT, 0],
    [EDIT_STATE_REMOVED_BY_EDIT, 0]
  ]);

  for (const cell of currentCells) {
    if (!isLatLngInsideGeoJson(cellToCenterLatLng(cell), boundary.geoJson)) continue;

    counts.set(cell.editState, (counts.get(cell.editState) || 0) + 1);
  }

  const normal = counts.get(EDIT_STATE_NORMAL) || 0;
  const added = counts.get(EDIT_STATE_ADDED_BY_EDIT) || 0;
  const removed = counts.get(EDIT_STATE_REMOVED_BY_EDIT) || 0;

  return { normal, added, removed };
}

function applyCityStats(boundary, counts) {
  const normal = counts.normal || counts.gps || 0;
  const added = counts.added || 0;
  const removed = counts.removed || 0;
  const total = Number.isFinite(counts.total) ? counts.total : boundary.totalGridCells;
  const visited = Number.isFinite(counts.visited) ? counts.visited : normal + added;

  cityStatsTitle.textContent = `Ville de ${boundary.name}`;
  cityVisitedCells.textContent = formatNumber(visited);
  cityVisitedCells.dataset.value = String(visited);
  updateCityTotalAndPercent({ ...boundary, totalGridCells: total });
  cityNormalCells.textContent = formatNumber(normal);
  cityAddedCells.textContent = formatNumber(added);
  cityRemovedCells.textContent = formatNumber(removed);
  cityStats.classList.remove("is-hidden");
}

function buildCityStats(counts, totalGridCells) {
  const normal = counts.normal || 0;
  const added = counts.added || 0;
  const removed = counts.removed || 0;
  const total = Number.isFinite(totalGridCells) ? totalGridCells : 0;
  const visited = normal + added;
  const percent = total > 0 ? (100.0 * visited) / total : 0;

  return {
    gps: normal,
    normal,
    added,
    removed,
    visited,
    total,
    percent,
    computedAt: Date.now()
  };
}

function isValidCachedCityStats(stats) {
  return Boolean(
    stats &&
    Number.isFinite(stats.normal) &&
    Number.isFinite(stats.added) &&
    Number.isFinite(stats.removed) &&
    Number.isFinite(stats.visited) &&
    Number.isFinite(stats.total) &&
    Number.isFinite(stats.percent)
  );
}

function updateCityTotalAndPercent(boundary) {
  if (!Number.isFinite(boundary.totalGridCells)) {
    cityTotalCells.textContent = "...";
    cityPercent.textContent = "...";
    return;
  }

  const visited = Number(cityVisitedCells.dataset.value || 0);
  const percent = boundary.totalGridCells > 0
    ? (100.0 * visited) / boundary.totalGridCells
    : 0;

  cityTotalCells.textContent = formatNumber(boundary.totalGridCells);
  cityPercent.textContent = `${percent.toLocaleString("fr-FR", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  })}%`;
}

function setStatus(message) {
  statusBar.textContent = message;
}

function formatNumber(value) {
  return new Intl.NumberFormat("fr-FR").format(value);
}

function formatTimelineDate(value) {
  if (!Number.isFinite(value)) return "--";

  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function webMercatorXToLongitude(x) {
  return (x / WEB_MERCATOR_HALF_WORLD_METERS) * 180.0;
}

function longitudeToWebMercatorX(longitude) {
  return WEB_MERCATOR_HALF_WORLD_METERS * longitude / 180.0;
}

function webMercatorYToLatitude(y) {
  const radians = 2.0 * Math.atan(Math.exp(y / WEB_MERCATOR_EARTH_RADIUS)) - Math.PI / 2.0;
  return radians * 180.0 / Math.PI;
}

function latitudeToWebMercatorY(latitude) {
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = clampedLatitude * Math.PI / 180.0;
  return WEB_MERCATOR_EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4.0 + radians / 2.0));
}

function latLngToGridCell(latlng) {
  return {
    column: Math.floor(longitudeToWebMercatorX(latlng.lng) / GRID_CELL_SIZE_METERS),
    row: Math.floor(latitudeToWebMercatorY(latlng.lat) / GRID_CELL_SIZE_METERS)
  };
}

function revealedCellsAround(latlng) {
  const pointX = longitudeToWebMercatorX(latlng.lng);
  const pointY = latitudeToWebMercatorY(latlng.lat);
  const minColumn = Math.floor((pointX - GRID_CELL_SIZE_METERS) / GRID_CELL_SIZE_METERS);
  const maxColumn = Math.ceil((pointX + GRID_CELL_SIZE_METERS) / GRID_CELL_SIZE_METERS);
  const minRow = Math.floor((pointY - GRID_CELL_SIZE_METERS) / GRID_CELL_SIZE_METERS);
  const maxRow = Math.ceil((pointY + GRID_CELL_SIZE_METERS) / GRID_CELL_SIZE_METERS);
  const cells = [];

  for (let column = minColumn; column <= maxColumn; column += 1) {
    const cellLeft = column * GRID_CELL_SIZE_METERS;
    const cellRight = cellLeft + GRID_CELL_SIZE_METERS;

    for (let row = minRow; row <= maxRow; row += 1) {
      const cellTop = row * GRID_CELL_SIZE_METERS;
      const cellBottom = cellTop + GRID_CELL_SIZE_METERS;
      const dx = pointX < cellLeft
        ? cellLeft - pointX
        : pointX > cellRight
          ? pointX - cellRight
          : 0;
      const dy = pointY < cellTop
        ? cellTop - pointY
        : pointY > cellBottom
          ? pointY - cellBottom
          : 0;

      if (dx * dx + dy * dy <= GRID_CELL_SIZE_METERS * GRID_CELL_SIZE_METERS) {
        cells.push({ column, row });
      }
    }
  }

  return cells;
}

function cellKey(column, row) {
  return `${column}:${row}`;
}
