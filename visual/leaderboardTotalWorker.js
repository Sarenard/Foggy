const GRID_CELL_SIZE_METERS = 15.0;
const WEB_MERCATOR_HALF_WORLD_METERS = 20037508.342789244;
const WEB_MERCATOR_EARTH_RADIUS = 6378137.0;

self.onmessage = (event) => {
  const { requestId, geoJson } = event.data || {};

  try {
    self.postMessage({
      requestId,
      totalGridCells: countGridCellsInsideGeoJson(geoJson)
    });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error && error.message ? error.message : String(error)
    });
  }
};

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

function longitudeToWebMercatorX(longitude) {
  return WEB_MERCATOR_HALF_WORLD_METERS * longitude / 180.0;
}

function latitudeToWebMercatorY(latitude) {
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = clampedLatitude * Math.PI / 180.0;
  return WEB_MERCATOR_EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4.0 + radians / 2.0));
}
