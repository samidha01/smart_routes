"""
rerouting.py
Background re-routing engine that:
  1. Keeps track of active route sessions (keyed by session_id)  
  2. Every 30 seconds fetches fresh traffic/weather data
  3. Recomputes scores for the active route vs alternatives
  4. If a better route is found → emits a WebSocket update
  5. Cleans up stale sessions automatically
"""

import asyncio
import logging
import time
import uuid
from typing import Dict, Any, Optional, List, Callable, Awaitable

from engine.feature_engine import batch_compute_features, features_to_vector
from engine.scoring import score_routes, compute_savings
from engine.ml_model import predict, get_model
from services.weather_api import get_weather_data

import numpy as np

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Re-routing interval (seconds)
# ──────────────────────────────────────────────────────────────────────────────
REROUTE_INTERVAL = 30         # seconds between re-checks
SESSION_TTL      = 3600       # auto-expire inactive sessions after 1 hour
IMPROVEMENT_THRESHOLD = 0.02  # emit update only if score improves by ≥ 2%


# ──────────────────────────────────────────────────────────────────────────────
# Session registry
# ──────────────────────────────────────────────────────────────────────────────

class RouteSession:
    __slots__ = (
        "session_id", "source", "destination",
        # Resolved geographic coordinates (always set for dynamic routing)
        "source_lat", "source_lon", "dest_lat", "dest_lon",
        "priority_coords",  # List[Tuple[float, float]]
        "vehicle_type", "vehicle_model", "mileage", "fuel_type",
        "priority_stops", "mode",
        "current_best_score", "current_best_path",
        "last_seen", "created_at",
        "callbacks",
    )

    def __init__(self, session_id: str, params: Dict[str, Any]):
        self.session_id         = session_id
        self.source             = params["source"]
        self.destination        = params["destination"]
        self.source_lat         = params.get("source_lat")
        self.source_lon         = params.get("source_lon")
        self.dest_lat           = params.get("dest_lat")
        self.dest_lon           = params.get("dest_lon")
        self.priority_coords    = params.get("priority_coords", [])
        self.vehicle_type       = params.get("vehicle_type", "car")
        self.vehicle_model      = params.get("vehicle_model", "")
        self.mileage            = float(params.get("mileage", 18.0))
        self.fuel_type          = params.get("fuel_type", "petrol")
        self.priority_stops     = params.get("priority_stops", [])
        self.mode               = params.get("mode", "fastest")
        self.current_best_score = float("inf")
        self.current_best_path  = []
        self.last_seen          = time.time()
        self.created_at         = time.time()
        self.callbacks: List[Callable[[Dict[str, Any]], Awaitable[None]]] = []

    def touch(self):
        self.last_seen = time.time()

    def is_expired(self) -> bool:
        return (time.time() - self.last_seen) > SESSION_TTL


# ──────────────────────────────────────────────────────────────────────────────
# Global session store
# ──────────────────────────────────────────────────────────────────────────────
_sessions: Dict[str, RouteSession] = {}
_reroute_task: Optional[asyncio.Task] = None


def create_session(params: Dict[str, Any]) -> str:
    """Create a new tracking session and return its session_id."""
    sid = str(uuid.uuid4())
    _sessions[sid] = RouteSession(sid, params)
    logger.info("New re-route session: %s (%s → %s)", sid, params["source"], params["destination"])
    return sid


def update_session_best(session_id: str, score: float, path: List[str]):
    if session_id in _sessions:
        sess = _sessions[session_id]
        sess.current_best_score = score
        sess.current_best_path  = path
        sess.touch()


def register_ws_callback(session_id: str, callback: Callable[[Dict[str, Any]], Awaitable[None]]):
    """Attach an async WebSocket send callback to a session."""
    if session_id in _sessions:
        _sessions[session_id].callbacks.append(callback)


def remove_session(session_id: str):
    _sessions.pop(session_id, None)


def get_session(session_id: str) -> Optional[RouteSession]:
    return _sessions.get(session_id)


# ──────────────────────────────────────────────────────────────────────────────
# Core re-routing logic
# ──────────────────────────────────────────────────────────────────────────────

from engine.dynamic_routing import get_dynamic_routes

async def _reroute_session(sess: RouteSession):
    """Re-evaluate a single session with fresh live data (coordinate-based)."""

    s_lat, s_lon = sess.source_lat, sess.source_lon
    d_lat, d_lon = sess.dest_lat, sess.dest_lon

    if None in (s_lat, s_lon, d_lat, d_lon):
        logger.debug("Session %s missing coords, skipping reroute", sess.session_id)
        return

    # Fetch fresh context data
    weather_data = await get_weather_data(sess.source)

    # Generate candidate paths dynamically (with stored priority coords)
    try:
        paths = await get_dynamic_routes(
            slat=s_lat, slon=s_lon,
            dlat=d_lat, dlon=d_lon,
            priority_coords=sess.priority_coords,
        )
    except Exception as exc:
        logger.warning("Reroute path gen failed for %s: %s", sess.session_id, exc)
        return

    if not paths:
        return

    # Compute features
    features_list = batch_compute_features(
        routes=paths,
        weather_data=weather_data,
        vehicle_type=sess.vehicle_type,
        mileage=sess.mileage,
        fuel_type=sess.fuel_type,
        priority_stops=sess.priority_stops,
        mode=sess.mode,
    )

    # ML predictions
    try:
        fvecs = np.array([features_to_vector(f) for f in features_list])
        ml_preds = predict(fvecs)
    except Exception:
        ml_preds = None

    # Score
    scored = score_routes(features_list, mode=sess.mode, ml_predictions=ml_preds)
    if not scored:
        return

    new_best = scored[0]
    new_score = new_best["composite_score"]

    improvement = (sess.current_best_score - new_score) / max(sess.current_best_score, 1e-9)

    if improvement >= IMPROVEMENT_THRESHOLD:
        logger.info(
            "Session %s: better route found (score %.4f → %.4f, +%.1f%%)",
            sess.session_id, sess.current_best_score, new_score, improvement * 100,
        )
        savings = compute_savings(new_best, {"estimated_time_min": 0, "fuel_estimate": 0})
        if len(scored) > 1:
            savings = compute_savings(new_best, scored[1])

        update_data = {
            "event":              "reroute_update",
            "session_id":         sess.session_id,
            "improvement_pct":    round(improvement * 100, 2),
            "new_best_route":     _serialise_route(new_best),
            "alternatives":       [_serialise_route(s) for s in scored[1:4]],
            "savings":            savings,
            "timestamp":          time.time(),
        }

        # Update session state
        update_session_best(sess.session_id, new_score, new_best["path"])

        # Fire all registered callbacks (WebSocket senders)
        dead_callbacks = []
        for i, cb in enumerate(sess.callbacks):
            try:
                await cb(update_data)
            except Exception as exc:
                logger.warning("WS callback error: %s", exc)
                dead_callbacks.append(i)
        # Prune dead callbacks
        for i in reversed(dead_callbacks):
            sess.callbacks.pop(i)
    else:
        logger.debug(
            "Session %s: no improvement (%.4f vs %.4f)",
            sess.session_id, new_score, sess.current_best_score,
        )


# ──────────────────────────────────────────────────────────────────────────────
# Background loop
# ──────────────────────────────────────────────────────────────────────────────

async def _reroute_loop():
    """Infinite background loop – runs every REROUTE_INTERVAL seconds."""
    logger.info("Re-routing background loop started (interval=%ds)", REROUTE_INTERVAL)
    try:
        while True:
            await asyncio.sleep(REROUTE_INTERVAL)

            # Clean up expired sessions first
            expired = [sid for sid, s in _sessions.items() if s.is_expired()]
            for sid in expired:
                logger.info("Session %s expired, removing.", sid)
                remove_session(sid)

            if not _sessions:
                continue

            # Reroute all active sessions concurrently
            tasks = [
                asyncio.create_task(_reroute_session(sess))
                for sess in list(_sessions.values())
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for r in results:
                if isinstance(r, Exception):
                    logger.error("Reroute task error: %s", r)

    except asyncio.CancelledError:
        logger.info("Re-routing loop cancelled.")


async def start_rerouting_loop():
    """Start the background loop (called from FastAPI lifespan)."""
    global _reroute_task
    if _reroute_task is None or _reroute_task.done():
        _reroute_task = asyncio.create_task(_reroute_loop())


async def stop_rerouting_loop():
    """Gracefully stop the background loop."""
    global _reroute_task
    if _reroute_task and not _reroute_task.done():
        _reroute_task.cancel()
        try:
            await _reroute_task
        except asyncio.CancelledError:
            pass
    _reroute_task = None


# ──────────────────────────────────────────────────────────────────────────────
# Serialisation helper
# ──────────────────────────────────────────────────────────────────────────────

_GEO_CACHE = None

def _serialise_route(r: Dict[str, Any]) -> Dict[str, Any]:
    """Return a JSON-safe subset of a scored route dict."""
    path = r.get("path", [])
    seg_traffic = r.get("segment_traffic", [])
    
    path_geometry = path
    segment_details = []
    
    # We sampled traffic every `step` points. Recreate colored segments.
    if len(path) > 1:
        step = max(1, len(path) // 15)
        for i in range(0, len(path)-1, step):
            segment_coords = path[i:min(i+step+1, len(path))]
            
            # Map back to traffic array
            traffic_idx = i // step
            density = seg_traffic[traffic_idx] if traffic_idx < len(seg_traffic) else 0.5
            
            # Traffic coloring
            if density > 0.70:
                color = [255, 79, 109] # Red / Heavy
            elif density > 0.40:
                color = [245, 166, 35] # Yellow / Moderate
            else:
                color = [34, 212, 114] # Green / Free flow
                
            segment_details.append({
                "path": segment_coords,
                "color": color,
                "density": density
            })
                
    return {
        "rank":               r.get("rank"),
        "path":               path,
        "path_geometry":      path_geometry,
        "segments":           segment_details,
        "node_count":         r.get("node_count"),
        "distance_km":        r.get("distance_km"),
        "estimated_time_min": r.get("estimated_time_min"),
        "base_time_min":      r.get("base_time_min"),
        "traffic_density":    r.get("traffic_density"),
        "signals_count":      r.get("signals_count"),
        "fuel_estimate":      r.get("fuel_estimate"),
        "weather_impact":     r.get("weather_impact"),
        "weather_condition":  r.get("weather_condition"),
        "road_quality_score": r.get("road_quality_score"),
        "priority_deviation": r.get("priority_deviation"),
        "composite_score":    r.get("composite_score"),
        "score_breakdown":    r.get("score_breakdown", {}),
        "ml_predicted_cost":  r.get("ml_predicted_cost"),
        "road_type_breakdown":r.get("road_type_breakdown", {}),
    }
