const GRID_CELL_SIZE_METERS = 15.0;
const WEB_MERCATOR_HALF_WORLD_METERS = 20037508.342789244;
const WEB_MERCATOR_EARTH_RADIUS = 6378137.0;

const EDIT_STATE_NORMAL = 0;
const EDIT_STATE_ADDED_BY_EDIT = 1;
const EDIT_STATE_REMOVED_BY_EDIT = 2;

let currentCells = [];

self.onmessage = (event) => {
  const { requestId, type, payload } = event.data || {};

  try {
    if (type === "setCells") {
      currentCells = Array.isArray(payload && payload.cells) ? payload.cells : [];
      postResult(requestId, { cellCount: currentCells.length });
      return;
    }

    if (type === "findBoundaryContaining") {
      const latlng = payload && payload.latlng;
      const boundaries = Array.isArray(payload && payload.boundaries) ? payload.boundaries : [];
      const boundary = boundaries.find((item) =>
        item && item.geoJson && isLatLngInsideGeoJson(latlng, item.geoJson)
      );

      postResult(requestId, { boundaryKey: boundary ? boundary.key : null });
      return;
    }

    if (type === "countCellsInsideBoundary") {
      const boundary = payload && payload.boundary;
      postResult(requestId, countCellsInsideBoundary(boundary));
      return;
    }

    if (type === "countGridCellsInsideGeoJson") {
      const geoJson = payload && payload.geoJson;
      postResult(requestId, { totalGridCells: countGridCellsInsideGeoJson(geoJson) });
      return;
    }

    if (type === "scanLeaderboardCachedBatch") {
      postResult(requestId, scanLeaderboardCachedBatch(payload || {}));
      return;
    }

    throw new Error(`Tâche worker inconnue : ${type}`);
  } catch (error) {
    postError(requestId, error);
  }
};

function postResult(requestId, result) {
  self.postMessage({ requestId, result });
}

function postError(requestId, error) {
  self.postMessage({
    requestId,
    error: error && error.message ? error.message : String(error)
  });
}

function countCellsInsideBoundary(boundary) {
  const counts = {
    normal: 0,
    added: 0,
    removed: 0
  };

  if (!boundary || !boundary.geoJson) {
    return counts;
  }

  for (const cell of currentCells) {
    if (!isLatLngInsideGeoJson(cellToCenterLatLng(cell), boundary.geoJson)) continue;

    if (cell.editState === EDIT_STATE_NORMAL) {
      counts.normal += 1;
    } else if (cell.editState === EDIT_STATE_ADDED_BY_EDIT) {
      counts.added += 1;
    } else if (cell.editState === EDIT_STATE_REMOVED_BY_EDIT) {
      counts.removed += 1;
    }
  }

  return counts;
}

function scanLeaderboardCachedBatch(payload) {
  const activeCells = currentCells.filter((cell) => cell.editState !== EDIT_STATE_REMOVED_BY_EDIT);
  const presentBoundaries = Array.isArray(payload.presentBoundaries) ? payload.presentBoundaries : [];
  const cacheBoundaries = Array.isArray(payload.cacheBoundaries) ? payload.cacheBoundaries : [];
  const batchSize = Math.max(1, Number(payload.batchSize) || 1000);
  const foundBoundaryKeys = new Set();
  const missingCellIndexes = [];
  let index = Math.max(0, Number(payload.startIndex) || 0);
  const endIndex = Math.min(activeCells.length, index + batchSize);

  while (index < endIndex) {
    const center = cellToCenterLatLng(activeCells[index]);
    const presentBoundary = findBoundaryContainingLatLng(center, presentBoundaries);
    const cachedBoundary = presentBoundary || findBoundaryContainingLatLng(center, cacheBoundaries);

    if (cachedBoundary && cachedBoundary.key) {
      foundBoundaryKeys.add(cachedBoundary.key);
    } else {
      missingCellIndexes.push(index);
    }

    index += 1;
  }

  return {
    done: index >= activeCells.length,
    nextIndex: index,
    processed: index,
    total: activeCells.length,
    boundaryKeys: Array.from(foundBoundaryKeys),
    missingCellIndexes
  };
}

function findBoundaryContainingLatLng(latlng, boundaries) {
  return boundaries.find((boundary) =>
    boundary && boundary.geoJson && isLatLngInsideGeoJson(latlng, boundary.geoJson)
  ) || null;
}

function isLatLngInsideGeoJson(latlng, geoJson) {
  if (!latlng || !geoJson) return false;

  if (geoJson.type === "Polygon") {
    return isLatLngInsidePolygonCoordinates(latlng, geoJson.coordinates);
  }

  if (geoJson.type === "MultiPolygon") {
    return geoJson.coordinates.some((polygon) => isLatLngInsidePolygonCoordinates(latlng, polygon));
  }

  return false;
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
  if (!geoJson) return [];

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

function cellToCenterLatLng(cell) {
  const centerX = (cell.column + 0.5) * GRID_CELL_SIZE_METERS;
  const centerY = (cell.row + 0.5) * GRID_CELL_SIZE_METERS;

  return {
    lat: webMercatorYToLatitude(centerY),
    lng: webMercatorXToLongitude(centerX)
  };
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
