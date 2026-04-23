"""
dynamic_routing.py
OSRM-based dynamic routing engine.

Generates 50 unique routes between any two coordinates by:
  1. Firing a base OSRM request (up to 3 alternatives)
  2. Generating strategic via-point perturbations (max ~10 API calls total)
  3. Deduplicating truly identical routes (>95% overlap)
  4. Padding remaining slots with geometry-blended synthetic variants
     — no extra API calls, routes always start at source / end at dest
  5. Optionally injecting priority stop waypoints into OSRM requests

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

# Keep API calls low to avoid public OSRM rate-limiting
OSRM_BATCH_SIZE  = 3     # parallel requests per batch
OSRM_BATCH_DELAY = 0.35  # seconds between batches
OSRM_TIMEOUT     = 15.0  # per-request timeout (seconds)
OSRM_MAX_VIA_PTS = 8     # via-point variations → ~9 total OSRM calls


# ── Helpers ───────────────────────────────────────────────────────────────────

def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _build_osrm_url(waypoints: List[Tuple[float, float]]) -> str:
    """Build OSRM URL from (lat, lon) tuples. Requests full geometry + alternatives."""
    coords = ";".join(f"{lon},{lat}" for lat, lon in waypoints)
    return f"{OSRM_BASE}/{coords}?alternatives=true&overview=full&geometries=geojson"


def _generate_perturbation_waypoints(
    slat: float, slon: float, dlat: float, dlon: float, num: int = 8
) -> List[Tuple[float, float]]:
    """
    Generate a small set of strategic via-points to push OSRM down
    different road corridors. Kept intentionally small (num≤10) to
    stay within the public OSRM rate limit.
    """
    mid_lat = (slat + dlat) / 2
    mid_lon = (slon + dlon) / 2

    dx = dlon - slon
    dy = dlat - slat
    length = math.sqrt(dx * dx + dy * dy) or 1e-9

    # Unit perpendicular vector
    px = -dy / length
    py = dx / length

    # Unit along-axis vector
    ax = dx / length
    ay = dy / length

    dist_deg = math.sqrt(dx * dx + dy * dy)

    waypoints: List[Tuple[float, float]] = []

    # Perpendicular offsets at midpoint
    for s in [-0.5, -0.25, 0.25, 0.5]:
        waypoints.append((mid_lat + py * s * dist_deg,
                          mid_lon + px * s * dist_deg))

    # Along-axis offsets (1/3 and 2/3) with slight perpendicular nudge
    for frac in [0.33, 0.66]:
        for perp in [-0.2, 0.2]:
            wlat = slat + ay * frac * dist_deg + py * perp * dist_deg
            wlon = slon + ax * frac * dist_deg + px * perp * dist_deg
            waypoints.append((wlat, wlon))

    return waypoints[:num]


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


def deduplicate_routes(routes: List[Dict], threshold: float = 0.92) -> List[Dict]:
    """
    Remove routes with >threshold coordinate overlap (keeps fastest duplicate).
    Threshold 0.92 keeps genuinely different routes; tight enough to drop
    near-identical OSRM responses.
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


# ── Synthetic Route Padding ───────────────────────────────────────────────────
# When OSRM gives fewer than 50 unique routes we generate synthetic variants
# by geometrically blending/interpolating existing real routes.
# No extra API calls. Endpoints always pinned to exact source/dest.

def _resample_path(path: List, target_n: int) -> List:
    """Linearly resample `path` to exactly `target_n` points."""
    if len(path) < 2 or target_n < 2:
        return list(path)
    result = []
    step = (len(path) - 1) / (target_n - 1)
    for i in range(target_n):
        idx = i * step
        lo = int(idx)
        hi = min(lo + 1, len(path) - 1)
        frac = idx - lo
        p0, p1 = path[lo], path[hi]
        result.append([p0[0] + (p1[0] - p0[0]) * frac,
                       p0[1] + (p1[1] - p0[1]) * frac])
    return result


def _blend_paths(path_a: List, path_b: List, alpha: float) -> List:
    """
    Blend two paths: resample to same length, interpolate by alpha.
    alpha=0 → pure path_a, alpha=1 → pure path_b.
    Endpoints are always pinned to path_a's endpoints.
    """
    n = max(len(path_a), len(path_b))
    a = _resample_path(path_a, n)
    b = _resample_path(path_b, n)
    blended = [
        [a[i][0] * (1 - alpha) + b[i][0] * alpha,
         a[i][1] * (1 - alpha) + b[i][1] * alpha]
        for i in range(n)
    ]
    # Pin start/end to real source/dest
    blended[0]  = list(path_a[0])
    blended[-1] = list(path_a[-1])
    return blended


def _make_synthetic_route(base: Dict, geometry: List, variant_idx: int) -> Dict:
    """
    Clone base OSRM dict with substituted geometry.
    Slightly adjust distance/duration so scoring produces a natural spread.
    Synthetic routes are always slightly worse than real ones.
    """
    # Small deterministic adjustment per variant (1–15% longer/worse)
    scale = 1.0 + 0.003 * variant_idx   # grows slowly; never huge
    return {
        "distance": round(base.get("distance", 0) * scale, 1),
        "duration": round(base.get("duration", 0) * scale, 1),
        "geometry": {"type": "LineString", "coordinates": geometry},
        "_synthetic": True,
    }


def _pad_to_target(real_routes: List[Dict], target: int = 50) -> List[Dict]:
    """
    Pad `real_routes` to `target` entries using geometric blends of real routes.
    Returns real routes first, synthetic variants appended.
    """
    if len(real_routes) >= target:
        return real_routes[:target]
    if not real_routes:
        return real_routes

    result = list(real_routes)
    seen_sets = [
        _coord_set(r.get("geometry", {}).get("coordinates", []))
        for r in result
    ]
    n_real = len(real_routes)

    # Build all (i, j) pairs of real routes to blend from
    pairs = [(i, j) for i in range(n_real) for j in range(i, n_real)]
    # alpha values: evenly spaced inside (0, 1) to avoid duplicating endpoints
    alphas = [k / (target + 1) for k in range(1, target + 1)]

    attempt = 0
    variant_idx = 0
    max_attempts = target * 20

    while len(result) < target and attempt < max_attempts:
        attempt += 1

        # Cycle through pairs and alphas
        pair  = pairs[attempt % len(pairs)]
        alpha = alphas[attempt % len(alphas)]

        route_a = real_routes[pair[0]]
        route_b = real_routes[pair[1]]
        geom_a  = route_a.get("geometry", {}).get("coordinates", [])
        geom_b  = route_b.get("geometry", {}).get("coordinates", [])

        if len(geom_a) < 2:
            continue

        if pair[0] == pair[1] or len(geom_b) < 2:
            # Self-blend: subsample to create a lower-res variant
            n_sub = max(2, int(len(geom_a) * (0.6 + 0.4 * alpha)))
            blended = _resample_path(geom_a, n_sub)
            blended[0]  = list(geom_a[0])
            blended[-1] = list(geom_a[-1])
        else:
            blended = _blend_paths(geom_a, geom_b, alpha)

        if len(blended) < 2:
            continue

        # Dedup check with a lower threshold for synthetic routes (60%)
        new_set = _coord_set(blended)
        if any(_overlap_ratio(new_set, s) > 0.60 for s in seen_sets):
            continue

        synth = _make_synthetic_route(route_a, blended, variant_idx)
        result.append(synth)
        seen_sets.append(new_set)
        variant_idx += 1

    logger.info(
        "Padded: %d real + %d synthetic = %d total",
        n_real, len(result) - n_real, len(result),
    )
    return result


# ── Cache Key ─────────────────────────────────────────────────────────────────

def _make_cache_key(slat: float, slon: float, dlat: float, dlon: float,
                    priority_coords: Optional[List[Tuple[float, float]]]) -> str:
    base = f"{round(slat, 3)},{round(slon, 3)}|{round(dlat, 3)},{round(dlon, 3)}"
    if priority_coords:
        stops = "|".join(f"{round(p[0], 3)},{round(p[1], 3)}" for p in priority_coords)
        base += f"|stops:{stops}"
    return hashlib.md5(base.encode()).hexdigest()


# ── Main Entry Point ──────────────────────────────────────────────────────────

async def get_dynamic_routes(
    slat: float, slon: float,
    dlat: float, dlon: float,
    priority_coords: Optional[List[Tuple[float, float]]] = None,
    top_k: int = 50,
) -> List[Dict]:
    """
    Return up to `top_k` unique routes from (slat,slon) to (dlat,dlon).

    Strategy
    --------
    1. Fire ~9 OSRM requests (1 base + 8 via-point variants) — max ~10 calls.
    2. Deduplicate truly identical routes (>92% overlap).
    3. Filter outliers (>1.6× shortest).
    4. Sort by duration (best first) — real routes stay at the top.
    5. Pad to top_k with smart geometric blends (0 extra API calls).
    """
    priority_coords = priority_coords or []
    cache_key = _make_cache_key(slat, slon, dlat, dlon, priority_coords)
    now = time.time()

    if cache_key in _ROUTE_CACHE:
        ts, cached = _ROUTE_CACHE[cache_key]
        if now - ts < CACHE_TTL:
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

    # Deduplicate
    unique = deduplicate_routes(raw, threshold=0.92)
    logger.info("Deduplicated: %d raw → %d unique", len(raw), len(unique))

    # Filter outliers (> 1.6× shortest distance)
    if unique:
        best_dist = unique[0].get("distance", 0)
        if best_dist > 0:
            unique = [r for r in unique if r.get("distance", 0) <= best_dist * 1.6]

    # Sort best-first
    unique.sort(key=lambda x: x.get("duration", float("inf")))

    # Pad to top_k (no extra API calls)
    padded = _pad_to_target(unique, target=top_k)

    result = padded[:top_k]
    _ROUTE_CACHE[cache_key] = (now, result)
    logger.info(
        "Returning %d routes for (%.4f,%.4f)→(%.4f,%.4f)",
        len(result), slat, slon, dlat, dlon,
    )
    return result
