"""
geocoder.py
Geocoding with dual-provider fallback and OSRM road-snapping.

Flow:
  1. Primary: Nominatim (OpenStreetMap) – free, no key required
  2. Fallback: Photon (Komoot) – also free, OpenStreetMap-based
  3. After getting coordinates, snap to nearest road via OSRM /nearest

Cache: 24-hour TTL to avoid repeated calls.
"""

import asyncio
import hashlib
import logging
import time
from typing import List, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

# ── Cache ─────────────────────────────────────────────────────────────────────
# { cache_key: (timestamp, [results]) }
_GEOCODE_CACHE: Dict[str, tuple] = {}
_SNAP_CACHE: Dict[str, tuple] = {}
CACHE_TTL = 3600 * 24  # 24 hours

# ── Mumbai Metropolitan Region bounding box ───────────────────────────────────
# Covers Mumbai, Navi Mumbai, Thane, Kalyan, Dombivli, Badlapur, Karjat
MMR_BBOX = {
    "min_lat": 18.75,
    "max_lat": 19.45,
    "min_lon": 72.70,
    "max_lon": 73.50,
}

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
PHOTON_URL    = "https://photon.komoot.io/api/"
OSRM_NEAREST  = "https://router.project-osrm.org/nearest/v1/driving/{lon},{lat}?number=1"

# Nominatim requires a unique, valid User-Agent with contact info
# per their usage policy: https://operations.osmfoundation.org/policies/nominatim/
HEADERS = {
    "User-Agent": "SmartFlowRoutingEngine/2.0 (mrunmayi.smartroutes@gmail.com)",
    "Accept-Language": "en",
    "Referer": "https://smartflow-routing.app",
}


def _cache_key(query: str) -> str:
    return hashlib.md5(query.strip().lower().encode()).hexdigest()


def _in_mmr(lat: float, lon: float) -> bool:
    return (MMR_BBOX["min_lat"] <= lat <= MMR_BBOX["max_lat"] and
            MMR_BBOX["min_lon"] <= lon <= MMR_BBOX["max_lon"])


def _score_result(item: Dict, query: str) -> float:
    """Score result relevance; prefer MMR results."""
    score = 0.0
    lat = float(item.get("lat", 0))
    lon = float(item.get("lon", 0))
    if _in_mmr(lat, lon):
        score += 10.0
    name = item.get("name", "").lower()
    q_lower = query.lower()
    if q_lower in name:
        score += 5.0
    # Prefer more specific results (city/town/suburb over country)
    osm_class = item.get("class", "")
    if osm_class in ("place", "highway", "amenity", "building"):
        score += 2.0
    return score


# ── Provider: Nominatim ───────────────────────────────────────────────────────

async def _geocode_nominatim(query: str, limit: int, client: httpx.AsyncClient) -> List[Dict]:
    # Use viewbox bias (not bounded) so results PREFER the MMR but aren't excluded if outside
    params = {
        "q": query + ", Maharashtra, India",
        "format": "json",
        "addressdetails": 1,
        "limit": max(limit, 5),
        "countrycodes": "in",
        "viewbox": f"{MMR_BBOX['min_lon']},{MMR_BBOX['max_lat']},{MMR_BBOX['max_lon']},{MMR_BBOX['min_lat']}",
        "bounded": 0,  # bias, not restrict
    }
    try:
        resp = await client.get(NOMINATIM_URL, params=params, headers=HEADERS, timeout=8.0)
        logger.debug("Nominatim status=%d for '%s'", resp.status_code, query)
        if resp.status_code == 200:
            data = resp.json()
            results = []
            for item in data:
                lat = float(item.get("lat", 0))
                lon = float(item.get("lon", 0))
                results.append({
                    "name": item.get("display_name", ""),
                    "short_name": item.get("display_name", "").split(",")[0].strip(),
                    "lat": lat,
                    "lon": lon,
                    "confidence": float(item.get("importance", 0.5)),
                    "_score": _score_result(item, query),
                    "source": "nominatim",
                })
            return results
        elif resp.status_code == 403:
            logger.warning("Nominatim 403 – User-Agent may be blocked. Response: %s", resp.text[:200])
        else:
            logger.warning("Nominatim %d for '%s'", resp.status_code, query)
    except Exception as exc:
        logger.warning("Nominatim failed for '%s': %s", query, exc)
    return []


async def _geocode_nominatim_wide(query: str, limit: int, client: httpx.AsyncClient) -> List[Dict]:
    """Wider search without bounding box constraint for fallback."""
    params = {
        "q": query + ", India",
        "format": "json",
        "addressdetails": 1,
        "limit": max(limit, 5),
        "countrycodes": "in",
    }
    try:
        resp = await client.get(NOMINATIM_URL, params=params, headers=HEADERS, timeout=6.0)
        if resp.status_code == 200:
            data = resp.json()
            results = []
            for item in data:
                lat = float(item.get("lat", 0))
                lon = float(item.get("lon", 0))
                results.append({
                    "name": item.get("display_name", ""),
                    "short_name": item.get("display_name", "").split(",")[0].strip(),
                    "lat": lat,
                    "lon": lon,
                    "confidence": float(item.get("importance", 0.5)),
                    "_score": _score_result(item, query),
                    "source": "nominatim_wide",
                })
            return results
    except Exception as exc:
        logger.warning("Nominatim wide search failed for '%s': %s", query, exc)
    return []


# ── Provider: Photon (Komoot) ─────────────────────────────────────────────────

async def _geocode_photon(query: str, limit: int, client: httpx.AsyncClient) -> List[Dict]:
    """Photon geocoder -- free, OpenStreetMap-based, good for Indian addresses."""
    params = {
        "q": query + ", India",
        "limit": max(limit, 5),
        "lang": "en",
        # Bias search towards Mumbai/MMR center
        "lat": "19.076",
        "lon": "72.877",
    }
    try:
        resp = await client.get(PHOTON_URL, params=params, headers=HEADERS, timeout=8.0)
        if resp.status_code == 200:
            data = resp.json()
            features = data.get("features", [])
            results = []
            for feat in features:
                props = feat.get("properties", {})
                coords = feat.get("geometry", {}).get("coordinates", [None, None])
                if not coords[0]:
                    continue
                lon, lat = float(coords[0]), float(coords[1])
                # Build display name
                parts = [
                    props.get("name", ""),
                    props.get("street", ""),
                    props.get("city", ""),
                    props.get("state", ""),
                ]
                display = ", ".join(p for p in parts if p)
                # Create mock item for scoring
                mock_item = {"lat": lat, "lon": lon, "class": props.get("osm_value", "")}
                results.append({
                    "name": display or props.get("name", "Unknown"),
                    "short_name": props.get("name", display.split(",")[0] if display else "Unknown"),
                    "lat": lat,
                    "lon": lon,
                    "confidence": 0.6,
                    "_score": _score_result(mock_item, query),
                    "source": "photon",
                })
            return results
    except Exception as exc:
        logger.warning("Photon geocoder failed for '%s': %s", query, exc)
    return []


# ── Road Snapping ─────────────────────────────────────────────────────────────

async def snap_to_road(lat: float, lon: float) -> tuple:
    """
    Snap raw geocoded coordinates to the nearest road using OSRM /nearest.
    Returns (snapped_lat, snapped_lon). Falls back to original if OSRM unavailable.
    """
    cache_key = f"{round(lat, 4)},{round(lon, 4)}"
    now = time.time()
    if cache_key in _SNAP_CACHE:
        ts, result = _SNAP_CACHE[cache_key]
        if now - ts < CACHE_TTL:
            return result

    url = OSRM_NEAREST.format(lat=lat, lon=lon)
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("code") == "Ok":
                    waypoints = data.get("waypoints", [])
                    if waypoints:
                        loc = waypoints[0].get("location", [lon, lat])
                        snapped = (loc[1], loc[0])  # (lat, lon)
                        _SNAP_CACHE[cache_key] = (now, snapped)
                        return snapped
    except Exception as exc:
        logger.warning("OSRM road-snap failed for (%s, %s): %s", lat, lon, exc)

    # Fallback: return original coords
    original = (lat, lon)
    _SNAP_CACHE[cache_key] = (now, original)
    return original


# ── Main Geocode Function ─────────────────────────────────────────────────────

async def geocode(query: str, limit: int = 5, snap: bool = True) -> List[Dict]:
    """
    Geocode a free-text address with fallback providers and road snapping.

    Returns top `limit` results sorted by relevance (MMR-biased).
    If exact match fails, returns top 3 suggestions.
    """
    q_stripped = query.strip()
    if not q_stripped:
        return []

    key = _cache_key(q_stripped)
    now = time.time()
    if key in _GEOCODE_CACHE:
        cached_time, cached_results = _GEOCODE_CACHE[key]
        if now - cached_time < CACHE_TTL:
            return cached_results[:limit]

    results = []
    async with httpx.AsyncClient(timeout=8.0) as client:
        # Strategy 1: Nominatim with MMR bounding box
        results = await _geocode_nominatim(q_stripped, limit, client)

        # Strategy 2: If no MMR results, try wider Nominatim
        if not results or not any(_in_mmr(r["lat"], r["lon"]) for r in results):
            wide = await _geocode_nominatim_wide(q_stripped, limit, client)
            # Merge, preferring MMR-bounded results
            seen_locs = {(round(r["lat"], 3), round(r["lon"], 3)) for r in results}
            for r in wide:
                loc = (round(r["lat"], 3), round(r["lon"], 3))
                if loc not in seen_locs:
                    results.append(r)
                    seen_locs.add(loc)

        # Strategy 3: Photon fallback if still nothing good
        if not results:
            logger.info("Falling back to Photon geocoder for '%s'", q_stripped)
            results = await _geocode_photon(q_stripped, limit, client)

    if not results:
        logger.warning("All geocoding providers failed for '%s'", q_stripped)
        return []

    # Sort by composite score (MMR-biased)
    results.sort(key=lambda x: x.get("_score", 0), reverse=True)

    # Deduplicate by proximity (~200m)
    deduped = []
    for r in results:
        is_dup = any(
            abs(r["lat"] - d["lat"]) < 0.002 and abs(r["lon"] - d["lon"]) < 0.002
            for d in deduped
        )
        if not is_dup:
            deduped.append(r)

    # Road-snap top results if requested
    if snap and deduped:
        snap_tasks = [snap_to_road(r["lat"], r["lon"]) for r in deduped[:limit]]
        snapped_coords = await asyncio.gather(*snap_tasks, return_exceptions=True)
        for i, snapped in enumerate(snapped_coords):
            if isinstance(snapped, tuple) and i < len(deduped):
                deduped[i]["lat"] = snapped[0]
                deduped[i]["lon"] = snapped[1]
                deduped[i]["snapped"] = True

    # Clean up internal scoring key
    for r in deduped:
        r.pop("_score", None)

    final = deduped[:max(limit, 3)]  # Always return at least 3 for suggestions
    _GEOCODE_CACHE[key] = (now, final)
    logger.info("Geocoded '%s' → %d results (provider: %s)",
                q_stripped, len(final), final[0].get("source", "?") if final else "none")
    return final[:limit]


async def geocode_with_suggestions(query: str) -> Dict:
    """
    Returns best match + top suggestions.
    Useful for ambiguous locations.
    """
    results = await geocode(query, limit=5, snap=True)
    if not results:
        return {"match": None, "suggestions": [], "error": f"Location '{query}' not found"}

    return {
        "match": results[0],
        "suggestions": results[1:],
        "error": None,
    }
