#!/usr/bin/env python3
import json
import math
import os
import queue
import sqlite3
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parent
DEFAULT_PORT = 4173
MAX_DB_BYTES = int(os.environ.get("FOGGY_VISUAL_MAX_DB_BYTES", str(512 * 1024 * 1024)))
GRID_CELL_SIZE_METERS = 15.0
WEB_MERCATOR_HALF_WORLD_METERS = 20037508.342789244
WEB_MERCATOR_EARTH_RADIUS = 6378137.0
EDIT_STATE_NORMAL = 0
EDIT_STATE_ADDED_BY_EDIT = 1
EDIT_STATE_REMOVED_BY_EDIT = 2
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
NOMINATIM_MIN_REQUEST_INTERVAL_SECONDS = 5
NOMINATIM_TIMEOUT_SECONDS = 8
LEADERBOARD_REFRESH_INTERVAL_SECONDS = float(os.environ.get("FOGGY_VISUAL_LEADERBOARD_REFRESH_SECONDS", "5"))
BOUNDARY_CACHE_PATH = Path(os.environ.get(
    "FOGGY_VISUAL_BOUNDARY_CACHE",
    str(SERVER_DIR / "city_boundary_cache.json"),
))
BOUNDARY_CACHE_VERSION = 1
USER_AGENT = os.environ.get(
    "FOGGY_VISUAL_USER_AGENT",
    "FoggyVisualLocal/1.0 (local development)",
)
last_nominatim_request_at = 0.0
jobs = {}
jobs_lock = threading.Lock()
boundary_cache_lock = threading.Lock()


class FoggyVisualHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)

        if parsed_url.path == "/health":
            self.send_json({"ok": True})
            return

        if parsed_url.path == "/api/leaderboard-stream":
            self.stream_leaderboard(parsed_url)
            return

        self.send_json({"error": "API Foggy Visual seulement"}, HTTPStatus.NOT_FOUND)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/api/parse-db":
            self.send_json({"error": "Endpoint inconnu"}, HTTPStatus.NOT_FOUND)
            return

        try:
            db_bytes = self.read_request_body()
            parsed = parse_db_bytes(db_bytes)
            self.send_json(parsed)
        except ClientError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self.log_error("Erreur parse DB: %s", error)
            self.send_json({"error": "Impossible de parser la DB"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def read_request_body(self):
        length_header = self.headers.get("Content-Length")
        if not length_header:
            raise ClientError("Corps de requête vide")

        try:
            content_length = int(length_header)
        except ValueError as error:
            raise ClientError("Content-Length invalide") from error

        if content_length <= 0:
            raise ClientError("DB vide")
        if content_length > MAX_DB_BYTES:
            raise ClientError(f"DB trop grosse ({content_length} octets, max {MAX_DB_BYTES})")

        db_bytes = self.rfile.read(content_length)
        if len(db_bytes) != content_length:
            raise ClientError("DB reçue incomplète")

        return db_bytes

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def stream_leaderboard(self, parsed_url):
        params = urllib.parse.parse_qs(parsed_url.query)
        job_id = (params.get("jobId") or [""])[0]
        job = get_job(job_id)

        if not job:
            self.send_json({"error": "Job leaderboard inconnu"}, HTTPStatus.NOT_FOUND)
            return

        subscriber = job.subscribe()
        self.send_response(HTTPStatus.OK)
        self.send_cors_headers()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        try:
            self.write_sse("leaderboard", job.current_payload())
            while True:
                try:
                    event = subscriber.get(timeout=20)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue

                self.write_sse(event["event"], event["payload"])
                if event["event"] == "done":
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            job.unsubscribe(subscriber)

    def write_sse(self, event, payload):
        body = json.dumps(payload, separators=(",", ":"))
        self.wfile.write(f"event: {event}\n".encode("utf-8"))
        self.wfile.write(f"data: {body}\n\n".encode("utf-8"))
        self.wfile.flush()


class ClientError(Exception):
    pass


def parse_db_bytes(db_bytes):
    with tempfile.NamedTemporaryFile(prefix="foggy-visual-", suffix=".db") as temp_db:
        temp_db.write(db_bytes)
        temp_db.flush()

        connection = sqlite3.connect(f"file:{temp_db.name}?mode=ro", uri=True)
        try:
            assert_v4_schema(connection)
            cells = read_cells(connection)
        finally:
            connection.close()

    leaderboard = build_leaderboard(cells)
    job = LeaderboardJob(cells, leaderboard)
    register_job(job)
    job.start()

    return {
        "schemaVersion": 4,
        "cells": cells,
        "leaderboard": leaderboard,
        "leaderboardJobId": job.job_id,
    }


def assert_v4_schema(connection):
    required_columns = {"grid_column", "grid_row", "recorded_at", "edit_state"}
    rows = connection.execute("PRAGMA table_info(gps_points)").fetchall()
    if not rows:
        raise ClientError("table gps_points absente")

    columns = {row[1] for row in rows}
    missing_columns = sorted(required_columns - columns)
    if missing_columns:
        raise ClientError(f"colonnes absentes: {', '.join(missing_columns)}")


def read_cells(connection):
    rows = connection.execute(
        """
        SELECT grid_column, grid_row, recorded_at, edit_state
        FROM gps_points
        ORDER BY recorded_at ASC
        """
    )

    return [
        {
            "column": int(column),
            "row": int(row),
            "recordedAt": int(recorded_at),
            "editState": int(edit_state),
        }
        for column, row, recorded_at, edit_state in rows
    ]


def build_leaderboard_payload(cells):
    active_cells = [cell for cell in cells if cell["editState"] != 2]
    return {
        "activeCells": len(active_cells),
        "totalCells": len(cells),
        "normalCells": sum(1 for cell in cells if cell["editState"] == 0),
        "addedCells": sum(1 for cell in cells if cell["editState"] == 1),
        "removedCells": sum(1 for cell in cells if cell["editState"] == 2),
    }


class LeaderboardJob:
    def __init__(self, cells, initial_leaderboard):
        self.job_id = uuid.uuid4().hex
        self.cells = cells
        self.leaderboard = initial_leaderboard
        self.subscribers = []
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, name=f"foggy-lb-{self.job_id[:8]}", daemon=True)
        self.attempted_cell_keys = set()
        self.fetched_boundaries = 0
        self.fetch_attempts = 0
        self.last_status = "En attente de la prochaine recherche."
        self.last_error = ""
        self.done = False

    def start(self):
        self.thread.start()

    def subscribe(self):
        subscriber = queue.Queue()
        with self.lock:
            self.subscribers.append(subscriber)
        return subscriber

    def unsubscribe(self, subscriber):
        with self.lock:
            if subscriber in self.subscribers:
                self.subscribers.remove(subscriber)

    def current_payload(self):
        with self.lock:
            return {
                "jobId": self.job_id,
                "leaderboard": self.leaderboard,
                "status": self.last_status,
                "error": self.last_error,
            }

    def publish(self, event, payload):
        with self.lock:
            subscribers = list(self.subscribers)

        for subscriber in subscribers:
            subscriber.put({"event": event, "payload": payload})

    def run(self):
        try:
            while True:
                time.sleep(LEADERBOARD_REFRESH_INTERVAL_SECONDS)
                candidate = find_next_uncached_cell(self.cells, self.attempted_cell_keys)

                if not candidate:
                    self.finish()
                    return

                self.attempted_cell_keys.add(cell_cache_key(candidate))
                self.fetch_attempts += 1
                self.last_error = ""
                self.last_status = f"Recherche frontière #{self.fetch_attempts}..."
                self.update_progress_only()
                self.publish("leaderboard", self.current_payload())

                boundary = fetch_city_boundary(cell_to_center_latlng(candidate))
                if boundary and is_allowed_city_boundary(boundary):
                    upsert_boundary_cache(boundary)
                    self.fetched_boundaries += 1
                    self.last_status = f"Frontière récupérée : {boundary.get('name') or 'Ville'}."
                elif boundary:
                    mark_boundary_cache_miss(candidate, f"frontière ignorée: {boundary.get('name') or 'sans nom'}")
                    self.last_status = f"Frontière ignorée : {boundary.get('name') or 'sans nom'}."
                else:
                    mark_boundary_cache_miss(candidate, "aucune frontière exploitable")
                    self.last_status = "Aucune frontière exploitable trouvée pour cette cellule."

                leaderboard = self.update_leaderboard()
                self.publish("leaderboard", self.current_payload())

                if leaderboard["complete"]:
                    self.finish()
                    return
        except Exception as error:
            self.last_error = str(error)
            self.last_status = "Job leaderboard arrêté sur erreur."
            self.publish("error", self.current_payload())

    def update_progress_only(self):
        with self.lock:
            self.leaderboard = {
                **self.leaderboard,
                "fetchedBoundaries": self.fetched_boundaries,
                "fetchAttempts": self.fetch_attempts,
            }

    def update_leaderboard(self):
        leaderboard = build_leaderboard(
            self.cells,
            fetched_boundaries=self.fetched_boundaries,
            fetch_attempts=self.fetch_attempts,
            refresh_interval_seconds=LEADERBOARD_REFRESH_INTERVAL_SECONDS,
        )
        with self.lock:
            self.leaderboard = leaderboard
        return leaderboard

    def finish(self):
        leaderboard = self.update_leaderboard()
        with self.lock:
            self.done = True

        self.publish("done", self.current_payload())


def register_job(job):
    with jobs_lock:
        jobs[job.job_id] = job


def get_job(job_id):
    with jobs_lock:
        return jobs.get(job_id)


def find_next_uncached_cell(cells, attempted_cell_keys):
    cache = load_boundary_cache()

    for cell in representative_active_cells(cells):
        if cell["editState"] == EDIT_STATE_REMOVED_BY_EDIT:
            continue

        key = cell_cache_key(cell)
        if key in attempted_cell_keys:
            continue

        latlng = cell_to_center_latlng(cell)
        if find_boundary_containing_latlng(latlng, cache["items"].values()):
            continue

        if key in cache["misses"]:
            continue

        return cell

    return None


def representative_active_cells(cells):
    seen_buckets = set()
    bucket_size = 250

    for cell in cells:
        if cell["editState"] == EDIT_STATE_REMOVED_BY_EDIT:
            continue

        bucket = (cell["column"] // bucket_size, cell["row"] // bucket_size)
        if bucket in seen_buckets:
            continue

        seen_buckets.add(bucket)
        yield cell

    for cell in cells:
        if cell["editState"] != EDIT_STATE_REMOVED_BY_EDIT:
            yield cell


def cell_cache_key(cell):
    return f"{cell['column']}:{cell['row']}"


def build_leaderboard(
    cells,
    fetched_boundaries=0,
    fetch_attempts=0,
    refresh_interval_seconds=LEADERBOARD_REFRESH_INTERVAL_SECONDS,
):
    summary = build_leaderboard_payload(cells)
    cache = load_boundary_cache()
    active_cells = [cell for cell in cells if cell["editState"] != EDIT_STATE_REMOVED_BY_EDIT]
    city_counts = {}
    unresolved_cells = 0
    cache_changed = False

    for cell in active_cells:
        latlng = cell_to_center_latlng(cell)
        boundary = find_boundary_containing_latlng(latlng, cache["items"].values())

        if not boundary or not is_allowed_city_boundary(boundary):
            unresolved_cells += 1
            continue

        key = boundary["key"]
        if key not in city_counts:
            total_grid_cells = boundary.get("totalGridCells")
            if not isinstance(total_grid_cells, int):
                total_grid_cells = count_grid_cells_inside_geojson(boundary.get("geoJson"))
                boundary["totalGridCells"] = total_grid_cells
                cache["items"][key] = boundary
                cache_changed = True

            city_counts[key] = {
                "key": key,
                "name": boundary.get("name") or "Ville",
                "boundaryType": boundary.get("boundaryType") or "",
                "countryCode": boundary.get("countryCode") or "",
                "normal": 0,
                "added": 0,
                "removed": 0,
                "visited": 0,
                "total": total_grid_cells,
                "percent": 0.0,
            }

        city = city_counts[key]
        if cell["editState"] == EDIT_STATE_ADDED_BY_EDIT:
            city["added"] += 1
        else:
            city["normal"] += 1
        city["visited"] = city["normal"] + city["added"]

    for city in city_counts.values():
        city["percent"] = (100.0 * city["visited"] / city["total"]) if city["total"] > 0 else 0.0

    if cache_changed:
        save_boundary_cache(cache)

    cities = sorted(city_counts.values(), key=lambda city: normalized_boundary_name(city["name"]))

    return {
        **summary,
        "cities": cities,
        "unresolvedCells": unresolved_cells,
        "fetchedBoundaries": fetched_boundaries,
        "fetchAttempts": fetch_attempts,
        "boundaryCacheItems": len(cache["items"]),
        "boundaryCacheMisses": len(cache["misses"]),
        "refreshIntervalSeconds": refresh_interval_seconds,
        "complete": unresolved_cells == 0,
    }


def empty_boundary_cache():
    return {
        "version": BOUNDARY_CACHE_VERSION,
        "items": {},
        "misses": {},
    }


def load_boundary_cache():
    if not BOUNDARY_CACHE_PATH.exists():
        return empty_boundary_cache()

    try:
        with BOUNDARY_CACHE_PATH.open("r", encoding="utf-8") as cache_file:
            payload = json.load(cache_file)
    except (OSError, json.JSONDecodeError):
        return empty_boundary_cache()

    if not isinstance(payload, dict):
        return empty_boundary_cache()

    if not isinstance(payload.get("items"), dict):
        payload["items"] = {}
    if not isinstance(payload.get("misses"), dict):
        payload["misses"] = {}
    payload["version"] = BOUNDARY_CACHE_VERSION

    return payload


def save_boundary_cache(cache):
    normalized_cache = {
        "version": BOUNDARY_CACHE_VERSION,
        "items": cache.get("items", {}),
        "misses": cache.get("misses", {}),
        "savedAt": int(time.time() * 1000),
    }
    with boundary_cache_lock:
        BOUNDARY_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temp_path = BOUNDARY_CACHE_PATH.with_suffix(".tmp")
        with temp_path.open("w", encoding="utf-8") as cache_file:
            json.dump(normalized_cache, cache_file, ensure_ascii=False, separators=(",", ":"))
        temp_path.replace(BOUNDARY_CACHE_PATH)


def upsert_boundary_cache(boundary):
    if not isinstance(boundary.get("totalGridCells"), int):
        boundary["totalGridCells"] = count_grid_cells_inside_geojson(boundary.get("geoJson"))

    boundary["cachedAt"] = int(time.time() * 1000)
    cache = load_boundary_cache()
    cache["items"][boundary["key"]] = boundary
    save_boundary_cache(cache)


def mark_boundary_cache_miss(cell, reason):
    cache = load_boundary_cache()
    latlng = cell_to_center_latlng(cell)
    cache["misses"][cell_cache_key(cell)] = {
        "column": cell["column"],
        "row": cell["row"],
        "lat": latlng["lat"],
        "lng": latlng["lng"],
        "reason": reason,
        "attemptedAt": int(time.time() * 1000),
    }
    save_boundary_cache(cache)


def fetch_city_boundary(latlng):
    global last_nominatim_request_at

    now = time.monotonic()
    wait_seconds = NOMINATIM_MIN_REQUEST_INTERVAL_SECONDS - (now - last_nominatim_request_at)
    if wait_seconds > 0:
        time.sleep(wait_seconds)

    query = urllib.parse.urlencode({
        "format": "jsonv2",
        "lat": str(latlng["lat"]),
        "lon": str(latlng["lng"]),
        "zoom": "10",
        "polygon_geojson": "1",
        "polygon_threshold": "0.0003",
        "accept-language": "fr",
    })
    request = urllib.request.Request(
        f"{NOMINATIM_REVERSE_URL}?{query}",
        headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    last_nominatim_request_at = time.monotonic()

    try:
        with urllib.request.urlopen(request, timeout=NOMINATIM_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    return boundary_from_nominatim(payload)


def boundary_from_nominatim(data):
    geo_json = data.get("geojson") if isinstance(data, dict) else None
    if not isinstance(geo_json, dict) or geo_json.get("type") not in ("Polygon", "MultiPolygon"):
        return None

    address = data.get("address") or {}
    if is_nominatim_country_boundary(data, address):
        return None

    name = (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("municipality")
        or address.get("county")
        or data.get("name")
        or data.get("display_name")
        or "Ville"
    )
    key = f"{data.get('osm_type') or 'place'}:{data.get('osm_id') or normalized_boundary_name(name)}"

    return {
        "key": key,
        "name": name,
        "boundaryType": data.get("addresstype") or data.get("type") or "",
        "countryCode": (address.get("country_code") or "").lower(),
        "hasLocalBoundaryName": bool(
            address.get("city")
            or address.get("town")
            or address.get("village")
            or address.get("municipality")
            or address.get("county")
        ),
        "geoJson": geo_json,
        "lastUsedAt": int(time.time() * 1000),
    }


def is_nominatim_country_boundary(data, address):
    is_low_rank_administrative_boundary = (
        data.get("type") == "administrative"
        and data.get("category") == "boundary"
        and int(data.get("place_rank") or 999) <= 4
    )
    has_only_country_address = (
        address.get("country")
        and not address.get("city")
        and not address.get("town")
        and not address.get("village")
        and not address.get("municipality")
        and not address.get("county")
    )

    return (
        data.get("addresstype") == "country"
        or is_low_rank_administrative_boundary
        or bool(has_only_country_address)
    )


def find_boundary_containing_latlng(latlng, boundaries):
    for boundary in boundaries:
        if (
            boundary
            and is_allowed_city_boundary(boundary)
            and is_latlng_inside_geojson(latlng, boundary.get("geoJson"))
        ):
            boundary["lastUsedAt"] = int(time.time() * 1000)
            return boundary

    return None


def is_allowed_city_boundary(boundary):
    if not boundary:
        return False
    name = normalized_boundary_name(boundary.get("name") or "")
    if boundary.get("boundaryType") == "country":
        return False
    if boundary.get("hasLocalBoundaryName") is False:
        return False
    if name in ("france", "republique francaise"):
        return False
    return True


def is_latlng_inside_geojson(latlng, geo_json):
    if not isinstance(geo_json, dict):
        return False

    if geo_json.get("type") == "Polygon":
        return is_latlng_inside_polygon_coordinates(latlng, geo_json.get("coordinates"))

    if geo_json.get("type") == "MultiPolygon":
        return any(
            is_latlng_inside_polygon_coordinates(latlng, polygon)
            for polygon in geo_json.get("coordinates") or []
        )

    return False


def is_latlng_inside_polygon_coordinates(latlng, polygon_coordinates):
    if not polygon_coordinates:
        return False

    outer_ring = polygon_coordinates[0]
    if not is_latlng_inside_ring(latlng, outer_ring):
        return False

    return all(not is_latlng_inside_ring(latlng, hole) for hole in polygon_coordinates[1:])


def is_latlng_inside_ring(latlng, ring):
    if not isinstance(ring, list) or len(ring) < 3:
        return False

    inside = False
    x = latlng["lng"]
    y = latlng["lat"]
    previous_index = len(ring) - 1

    for current_index, current in enumerate(ring):
        previous = ring[previous_index]
        current_x = float(current[0])
        current_y = float(current[1])
        previous_x = float(previous[0])
        previous_y = float(previous[1])
        crosses = (
            (current_y > y) != (previous_y > y)
            and x < ((previous_x - current_x) * (y - current_y)) / ((previous_y - current_y) or 1e-9) + current_x
        )

        if crosses:
            inside = not inside

        previous_index = current_index

    return inside


def count_grid_cells_inside_geojson(geo_json):
    projected_polygons = project_geojson_to_mercator_polygons(geo_json)
    bounds = compute_projected_bounds(projected_polygons)
    if not bounds:
        return 0

    min_column = int(bounds["minX"] // GRID_CELL_SIZE_METERS)
    max_column = int(-(-bounds["maxX"] // GRID_CELL_SIZE_METERS))
    min_row = int(bounds["minY"] // GRID_CELL_SIZE_METERS)
    max_row = int(-(-bounds["maxY"] // GRID_CELL_SIZE_METERS))
    total = 0

    for column in range(min_column, max_column + 1):
        center_x = (column + 0.5) * GRID_CELL_SIZE_METERS
        for row in range(min_row, max_row + 1):
            center_y = (row + 0.5) * GRID_CELL_SIZE_METERS
            if is_projected_point_inside_polygons({"x": center_x, "y": center_y}, projected_polygons):
                total += 1

    return total


def project_geojson_to_mercator_polygons(geo_json):
    if not isinstance(geo_json, dict):
        return []

    if geo_json.get("type") == "Polygon":
        return [project_polygon_coordinates_to_mercator(geo_json.get("coordinates") or [])]

    if geo_json.get("type") == "MultiPolygon":
        return [
            project_polygon_coordinates_to_mercator(polygon)
            for polygon in geo_json.get("coordinates") or []
        ]

    return []


def project_polygon_coordinates_to_mercator(polygon_coordinates):
    return [
        [
            {
                "x": longitude_to_web_mercator_x(float(longitude)),
                "y": latitude_to_web_mercator_y(float(latitude)),
            }
            for longitude, latitude in ring
        ]
        for ring in polygon_coordinates
    ]


def compute_projected_bounds(projected_polygons):
    min_x = float("inf")
    max_x = float("-inf")
    min_y = float("inf")
    max_y = float("-inf")

    for polygon in projected_polygons:
        outer_ring = polygon[0] if polygon else []
        for point in outer_ring:
            min_x = min(min_x, point["x"])
            max_x = max(max_x, point["x"])
            min_y = min(min_y, point["y"])
            max_y = max(max_y, point["y"])

    if not all(value not in (float("inf"), float("-inf")) for value in (min_x, max_x, min_y, max_y)):
        return None

    return {"minX": min_x, "maxX": max_x, "minY": min_y, "maxY": max_y}


def is_projected_point_inside_polygons(point, projected_polygons):
    return any(is_projected_point_inside_polygon(point, polygon) for polygon in projected_polygons)


def is_projected_point_inside_polygon(point, polygon):
    outer_ring = polygon[0] if polygon else []
    if not is_projected_point_inside_ring(point, outer_ring):
        return False

    return all(not is_projected_point_inside_ring(point, hole) for hole in polygon[1:])


def is_projected_point_inside_ring(point, ring):
    if not isinstance(ring, list) or len(ring) < 3:
        return False

    inside = False
    previous_index = len(ring) - 1

    for current_index, current in enumerate(ring):
        previous = ring[previous_index]
        crosses = (
            (current["y"] > point["y"]) != (previous["y"] > point["y"])
            and point["x"] < ((previous["x"] - current["x"]) * (point["y"] - current["y"])) / ((previous["y"] - current["y"]) or 1e-9) + current["x"]
        )

        if crosses:
            inside = not inside

        previous_index = current_index

    return inside


def cell_to_center_latlng(cell):
    center_x = (cell["column"] + 0.5) * GRID_CELL_SIZE_METERS
    center_y = (cell["row"] + 0.5) * GRID_CELL_SIZE_METERS
    return {
        "lat": web_mercator_y_to_latitude(center_y),
        "lng": web_mercator_x_to_longitude(center_x),
    }


def web_mercator_x_to_longitude(x):
    return x / WEB_MERCATOR_HALF_WORLD_METERS * 180.0


def longitude_to_web_mercator_x(longitude):
    return WEB_MERCATOR_HALF_WORLD_METERS * longitude / 180.0


def web_mercator_y_to_latitude(y):
    return (2.0 * math.atan(math.exp(y / WEB_MERCATOR_EARTH_RADIUS)) - math.pi / 2.0) * 180.0 / math.pi


def latitude_to_web_mercator_y(latitude):
    clamped_latitude = max(-85.05112878, min(85.05112878, latitude))
    radians = clamped_latitude * math.pi / 180.0
    return WEB_MERCATOR_EARTH_RADIUS * math.log(math.tan(math.pi / 4.0 + radians / 2.0))


def normalized_boundary_name(name):
    import unicodedata

    normalized = unicodedata.normalize("NFD", str(name).lower())
    return "".join(character for character in normalized if unicodedata.category(character) != "Mn")


def main():
    port = int(os.environ.get("FOGGY_VISUAL_PORT", str(DEFAULT_PORT)))
    server = ThreadingHTTPServer(("127.0.0.1", port), FoggyVisualHandler)
    print(f"Foggy Visual API: http://127.0.0.1:{port}/")
    print("Endpoints: GET /health, POST /api/parse-db")
    server.serve_forever()


if __name__ == "__main__":
    main()
