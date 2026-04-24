"""
dynamic_routing.py
OSRM-based dynamic routing engine.

Generates unique road-snapped routes between any two coordinates by:
  1. Firing a base OSRM request (up to 3 alternatives)
  2. Generating strategic via-point perturbations (max ~10 API calls total)
  3. Deduplicating truly identical routes (>92% overlap)
  4. Filtering outliers (>1.6× shortest route)
  5. Optionally injecting priority stop waypoints into OSRM requests

All returned routes follow real roads — no synthetic geometry padding.
This guarantees routes never cut through buildings, water, or off-road areas.

Cache: 5-minute TTL per (source, destination, priority_stops) tuple.
"""

import asyncio
import hashlib
import logging
import math
import time
from typing import List, Dict, Tuple, Optional

import httpx

logger = logging.getLogger("dynamic_routing")

# ── Cache ─────────────────────────────────────────────────────────────────────
_ROUTE_CACHE: Dict[str, tuple] = {}
CACHE_TTL = 300  # 5 minutes

OSRM_BASE = "https://router.project-osrm.org/route/v1/driving"
OSRM_TRIP = "http://router.project-osrm.org/trip/v1/driving"

# Keep API calls low to avoid public OSRM rate-limiting
OSRM_BATCH_SIZE  = 4     # parallel requests per batch
OSRM_BATCH_DELAY = 0.4   # seconds between batches
OSRM_TIMEOUT     = 18.0  # per-request timeout (seconds)
OSRM_MAX_VIA_PTS = 25    # via-point variations → ~26 total OSRM calls


# ── Helpers ───────────────────────────────────────────────────────────────────

def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _build_osrm_url(waypoints: List[Tuple[float, float]]) -> str:
    """Build OSRM URL from (lat, lon) tuples. Requests full geometry + up to 3 alternatives."""
    coords = ";".join(f"{lon},{lat}" for lat, lon in waypoints)
    # overview=full  → every road point in the geometry (not simplified)
    # geometries=geojson → [lon, lat] arrays we can render directly
    # alternatives=3  → up to 3 alternative routes per call
    # steps=false     → skip turn-by-turn
    # continue_straight=true → natural driving behavior at via-points
    return f"{OSRM_BASE}/{coords}?alternatives=3&overview=full&geometries=geojson&steps=false&continue_straight=true"


def _generate_perturbation_waypoints(
    slat: float, slon: float, dlat: float, dlon: float, num: int = 12
) -> List[Tuple[float, float]]:
    """
    Generate via-points that push OSRM through DIFFERENT road corridors.

    STRATEGY: Pick real landmarks/junctions from the CITY_NODES 'logical graph'
    that are geographically between the source and destination. This ensures
    via-points are always valid road-snapped locations and follow 'logical' paths.
    """
    # 1. Bounding box with some padding
    min_lat, max_lat = sorted([slat, dlat])
    min_lon, max_lon = sorted([slon, dlon])
    pad_lat = (max_lat - min_lat) * 0.2 + 0.01
    pad_lon = (max_lon - min_lon) * 0.2 + 0.01

    # 2. Find nodes inside the box
    candidates = []
    for node, attrs in CITY_NODES.items():
        n_lat, n_lon = attrs["lat"], attrs["lon"]
        if (min_lat - pad_lat <= n_lat <= max_lat + pad_lat and
            min_lon - pad_lon <= n_lon <= max_lon + pad_lon):
            candidates.append((n_lat, n_lon))

    # 3. If too few nodes (e.g. short route), pick K nearest nodes to midpoint
    if len(candidates) < num:
        mid_lat, mid_lon = (slat + dlat) / 2, (slon + dlon) / 2
        all_nodes = []
        for attrs in CITY_NODES.values():
            dist = (attrs["lat"] - mid_lat)**2 + (attrs["lon"] - mid_lon)**2
            all_nodes.append((dist, (attrs["lat"], attrs["lon"])))
        all_nodes.sort()
        candidates = [n for _, n in all_nodes[:num*2]]

    # 4. Return unique diverse selection
    import random
    if len(candidates) > num:
        return random.sample(candidates, num)
    return candidates[:num]


# ── OSRM Fetching ─────────────────────────────────────────────────────────────

async def _fetch_osrm_variants(
    slat: float, slon: float,
    dlat: float, dlon: float,
    waypoints: List[Tuple[float, float]],
    priority_coords: Optional[List[Tuple[float, float]]] = None,
) -> List[Dict]:
    """Fire OSRM requests in small batches. Returns all collected route dicts."""
    priority_coords = priority_coords or []
    src = (slat, slon)
    dst = (dlat, dlon)

    sequences: List[List[Tuple[float, float]]] = []
    # Base request (no extra via-point)
    sequences.append([src] + list(priority_coords) + [dst])
    # Via-point requests
    for via in waypoints:
        sequences.append([src] + list(priority_coords) + [via, dst])

    urls = [_build_osrm_url(seq) for seq in sequences]
    logger.info("OSRM: %d total requests, batch_size=%d", len(urls), OSRM_BATCH_SIZE)

    all_routes: List[Dict] = []
    ok_count = 0

    async with httpx.AsyncClient(timeout=OSRM_TIMEOUT) as client:
        for batch_start in range(0, len(urls), OSRM_BATCH_SIZE):
            batch = urls[batch_start: batch_start + OSRM_BATCH_SIZE]
            responses = await asyncio.gather(*[client.get(u) for u in batch],
                                             return_exceptions=True)
            for r in responses:
                if isinstance(r, Exception):
                    logger.debug("OSRM request failed: %s", r)
                    continue
                if not isinstance(r, httpx.Response) or r.status_code != 200:
                    continue
                try:
                    data = r.json()
                except Exception:
                    continue
                if data.get("code") == "Ok":
                    all_routes.extend(data.get("routes", []))
                    ok_count += 1

            if batch_start + OSRM_BATCH_SIZE < len(urls):
                await asyncio.sleep(OSRM_BATCH_DELAY)

    logger.info("OSRM: %d/%d ok, %d raw routes", ok_count, len(urls), len(all_routes))
    return all_routes


# ── Deduplication ─────────────────────────────────────────────────────────────

def _coord_set(geom_coords: List) -> frozenset:
    """Round coords to ~100 m precision and return as frozenset."""
    return frozenset((round(p[0], 3), round(p[1], 3)) for p in geom_coords)


def _overlap_ratio(s1: frozenset, s2: frozenset) -> float:
    if not s1 or not s2:
        return 0.0
    return len(s1 & s2) / min(len(s1), len(s2))


def deduplicate_routes(routes: List[Dict], threshold: float = 0.72) -> List[Dict]:
    """
    Remove routes with >threshold coordinate overlap (keeps fastest duplicate).
    Threshold 0.72 is loose enough to keep genuinely different urban routes
    (which naturally share arterials) while dropping near-exact duplicates.
    """
    routes_sorted = sorted(routes, key=lambda x: x.get("duration", float("inf")))
    unique: List[Dict] = []
    unique_sets: List[frozenset] = []

    for route in routes_sorted:
        geom = route.get("geometry", {}).get("coordinates", [])
        if not geom:
            continue
        rset = _coord_set(geom)
        if not any(_overlap_ratio(rset, u) > threshold for u in unique_sets):
            unique.append(route)
            unique_sets.append(rset)

    return unique


# ── Synthetic Route Padding (REMOVED) ──────────────────────────────────────────
# Removed to ensure all routes strictly follow real roads.
# No synthetic geometry interpolation allowed.



# ── TSP Stop Reordering ───────────────────────────────────────────────────────

async def _optimize_stop_order(
    slat: float, slon: float,
    dlat: float, dlon: float,
    stops: List[Tuple[float, float]]
) -> List[Tuple[float, float]]:
    """
    Uses the OSRM /trip endpoint to solve the Traveling Salesperson Problem.
    Returns the stops sorted in the most optimal visiting order.
    """
    if len(stops) < 2:
        return stops

    # Construct coordinate string: source;stop1;stop2...;destination
    coords_list = [f"{slon},{slat}"] + [f"{lon},{lat}" for (lat, lon) in stops] + [f"{dlon},{dlat}"]
    coords_str = ";".join(coords_list)
    
    url = f"{OSRM_TRIP}/{coords_str}?source=first&destination=last&roundtrip=false"
    
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("code") == "Ok":
                    waypoints = data.get("waypoints", [])
                    # waypoints[0] = source, waypoints[-1] = destination
                    # waypoints[1:-1] = stops in original input order
                    # waypoint["waypoint_index"] = optimized sequence position
                    middle_wps = waypoints[1:-1]
                    
                    if len(middle_wps) == len(stops):
                        stop_with_index = []
                        for idx, wp in enumerate(middle_wps):
                            stop_with_index.append((wp.get("waypoint_index", 0), stops[idx]))
                        
                        # Sort stops by their optimized waypoint sequence
                        stop_with_index.sort(key=lambda x: x[0])
                        sorted_stops = [s for _, s in stop_with_index]
                        
                        logger.info("Auto-optimized %d stops via TSP", len(stops))
                        return sorted_stops
    except Exception as exc:
        logger.warning("TSP optimization failed, falling back to input order: %s", exc)

    return stops


# ── Cache Key ─────────────────────────────────────────────────────────────────

def _make_cache_key(slat: float, slon: float, dlat: float, dlon: float,
                    priority_coords: Optional[List[Tuple[float, float]]]) -> str:
    # Use 6 decimal places (~10 cm precision) for cache keys
    # Ensures that even small moves by the user trigger a fresh (precisely snapped) route.
    base = f"{round(slat, 6)},{round(slon, 6)}|{round(dlat, 6)},{round(dlon, 6)}"
    if priority_coords:
        stops = "|".join(f"{round(p[0], 6)},{round(p[1], 6)}" for p in priority_coords)
        base += f"|stops:{stops}"
    return hashlib.md5(base.encode()).hexdigest()


# ── Main Entry Point ──────────────────────────────────────────────────────────

async def get_dynamic_routes(
    slat: float, slon: float,
    dlat: float, dlon: float,
    priority_coords: Optional[List[Tuple[float, float]]] = None,
    top_k: int = 50,
    optimize_stops: bool = False
) -> List[Dict]:
    """
    Generate up to `top_k` distinct, road-snapped routes.
    Features:
     - 1 Direct shortest path.
     - Multi-via perturbation (generates varied paths avoiding main congested arteries).
     - Geometric blending and strict road-snapping via map-matching.
     - Optional Traveling Salesperson (TSP) optimization for priority stops.
    """
    priority_coords = priority_coords or []

    if optimize_stops and len(priority_coords) > 1:
        priority_coords = await _optimize_stop_order(slat, slon, dlat, dlon, priority_coords)

    cache_key = _make_cache_key(slat, slon, dlat, dlon, priority_coords)
    now = time.time()

    if cache_key in _ROUTE_CACHE:
        cached = _ROUTE_CACHE[cache_key]
        logger.info("Serving %d routes from cache", len(cached))
        return cached[:top_k]

    via_points = _generate_perturbation_waypoints(
        slat, slon, dlat, dlon, num=OSRM_MAX_VIA_PTS
    )

    try:
        raw = await _fetch_osrm_variants(slat, slon, dlat, dlon, via_points, priority_coords)
    except Exception as exc:
        logger.error("OSRM fetch failed: %s", exc)
        raise

    if not raw:
        raise RuntimeError("OSRM returned no routes for the given coordinates.")

    # Deduplicate — threshold 0.92 keeps distinct urban alternatives
    unique = deduplicate_routes(raw, threshold=0.92)
    logger.info("Deduplicated: %d raw → %d unique", len(raw), len(unique))

    # Filter extreme outliers (>2.5× shortest) — keeps most alternatives
    if unique:
        best_dist = unique[0].get("distance", 0)
        if best_dist > 0:
            unique = [r for r in unique if r.get("distance", 0) <= best_dist * 2.5]

    # Sort best-first
    unique.sort(key=lambda x: x.get("duration", float("inf")))

    # Return only real OSRM routes — synthetic padding removed because
    # blended geometry does NOT follow roads (cuts through buildings/sea).
    result = unique[:top_k]
    _ROUTE_CACHE[cache_key] = result
    logger.info(
        "Returning %d real road-snapped routes for (%.4f,%.4f)→(%.4f,%.4f)",
        len(result), slat, slon, dlat, dlon,
    )
    return result
