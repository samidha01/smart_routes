"""
optimize.py
FastAPI router – all HTTP and WebSocket endpoints.

Endpoints
---------
POST /optimize-route                  – main route optimisation
GET  /routes/autocomplete             – geocode / autocomplete an address
GET  /routes/nodes                    – list all available graph nodes (legacy compat)
GET  /routes/vehicles                 – list vehicle database
GET  /routes/session/{session_id}     – get session info
DELETE /routes/session/{session_id}   – close session
GET  /routes/model-metrics            – ML model quality
WS   /ws/reroute/{session_id}         – real-time reroute WebSocket
"""

import asyncio
import json
import logging
import pathlib
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
from slowapi import Limiter
from slowapi.util import get_remote_address

from engine.graph_builder import get_graph, get_all_nodes, node_info, CITY_NODES
from engine.dynamic_routing import get_dynamic_routes
from engine.feature_engine import batch_compute_features, features_to_vector
from engine.scoring import score_routes, compute_savings
from engine.ml_model import predict, get_model_metrics
from engine.rerouting import (
    create_session, update_session_best,
    register_ws_callback, remove_session, get_session,
    _serialise_route,
)
from services.traffic_api import get_traffic_data, traffic_summary
from services.weather_api import get_weather_data, weather_summary
from services.geocoder import geocode, snap_to_road

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

# ──────────────────────────────────────────────────────────────────────────────
# Request / Response schemas
# ──────────────────────────────────────────────────────────────────────────────

MAX_PRIORITY_STOPS = 5  # Hard limit to keep OSRM URLs manageable

class PriorityStopObj(BaseModel):
    label: str
    lat: Optional[float] = None
    lon: Optional[float] = None

class OptimizeRouteRequest(BaseModel):
    source:         str   = Field(..., description="Origin address or location name")
    destination:    str   = Field(..., description="Destination address or location name")
    vehicle_type:   str   = Field("car",   description="bike | car | truck | tempo")
    vehicle_brand:  Optional[str]  = Field(None)
    vehicle_model:  Optional[str]  = Field(None)
    mileage:        Optional[float]= Field(None, description="km/L (auto-looked-up if blank)")
    fuel_type:      Optional[str]  = Field(None, description="petrol | diesel | electric | cng | hybrid")
    fuel_level:     float = Field(75.0, description="Remaining tank level %")
    optimize_stops: bool  = Field(False, description="Perform TSP reordering on priority_stops")
    priority_stops: Optional[List[PriorityStopObj]] = Field(default_factory=list, description="Must-visit locations (max 5)")
    mode:           str   = Field("fastest", description="fastest | eco")
    top_k:          int   = Field(50, ge=1, le=50)
    # Pre-resolved coordinates (set by frontend after geocoding)
    source_lat:     Optional[float] = Field(None)
    source_lon:     Optional[float] = Field(None)
    dest_lat:       Optional[float] = Field(None)
    dest_lon:       Optional[float] = Field(None)

    @validator("vehicle_type")
    def validate_vehicle_type(cls, v):
        allowed = {"bike", "car", "truck", "tempo"}
        if v.lower() not in allowed:
            raise ValueError(f"vehicle_type must be one of {allowed}")
        return v.lower()

    @validator("mode")
    def validate_mode(cls, v):
        if v.lower() not in {"fastest", "eco"}:
            raise ValueError("mode must be 'fastest' or 'eco'")
        return v.lower()

    @validator("priority_stops", pre=True)
    def validate_priority_stops(cls, v):
        if not v:
            return []
        
        parsed = []
        for item in v:
            if isinstance(item, str):
                parsed.append({"label": item})
            elif isinstance(item, dict):
                parsed.append(item)
            else:
                parsed.append(item)
                
        seen, deduped = set(), []
        for stop in parsed[:MAX_PRIORITY_STOPS]:
            label = stop.get("label", "").strip() if isinstance(stop, dict) else getattr(stop, "label", "").strip()
            key = label.lower()
            if key and key not in seen:
                seen.add(key)
                deduped.append(stop)
        return deduped


# ──────────────────────────────────────────────────────────────────────────────
# Vehicle DB lookup
# ──────────────────────────────────────────────────────────────────────────────


_VEHICLE_DB_PATH = pathlib.Path(__file__).parent.parent / "data" / "vehicle_db.json"

_VEHICLE_DB: Dict[str, Any] = {}

def _load_vehicle_db() -> Dict[str, Any]:
    global _VEHICLE_DB
    if not _VEHICLE_DB:
        with open(_VEHICLE_DB_PATH, "r", encoding="utf-8") as f:
            _VEHICLE_DB = json.load(f)
    return _VEHICLE_DB


def _lookup_vehicle(vehicle_type: str, brand: Optional[str], model: Optional[str]) -> Dict[str, Any]:
    db = _load_vehicle_db()
    vtype_map = {"bike": "bikes", "car": "cars", "truck": "trucks", "tempo": "tempos"}
    section_key = vtype_map.get(vehicle_type, "cars")
    section  = db.get(section_key, {})
    defaults = db.get("defaults", {}).get(vehicle_type, {"mileage": 18, "fuel_type": "petrol"})

    if brand and model:
        model_data = section.get(brand, {}).get(model, {})
        if model_data:
            return model_data
    if brand:
        brand_data = section.get(brand, {})
        if brand_data:
            return next(iter(brand_data.values()))
    return defaults


# ──────────────────────────────────────────────────────────────────────────────
# Coordinate resolution helpers
# ──────────────────────────────────────────────────────────────────────────────

async def _resolve_coords(label: str, provided_lat: Optional[float], provided_lon: Optional[float]) -> Tuple[float, float]:
    """
    Return (lat, lon) for a location label.
    Priority: provided coords → CITY_NODES fallback → geocode → road-snap.
    Raises HTTPException(400) if resolution completely fails.
    """
    if provided_lat is not None and provided_lon is not None:
        # Snap provided coords to nearest road
        snapped = await snap_to_road(provided_lat, provided_lon)
        return snapped

    # Check predefined nodes (legacy compatibility)
    if label in CITY_NODES:
        lat = CITY_NODES[label]["lat"]
        lon = CITY_NODES[label]["lon"]
        snapped = await snap_to_road(lat, lon)
        return snapped

    # Geocode the free-text label
    results = await geocode(label, limit=3, snap=True)
    if results:
        return results[0]["lat"], results[0]["lon"]

    # Try suggestions if completely failed
    suggestions = await geocode(label, limit=3, snap=False)
    sugg_names = [s.get("name", "") for s in suggestions]

    raise HTTPException(
        status_code=400,
        detail={
            "error": f"Location not found: '{label}'",
            "suggestions": sugg_names,
            "retry_hint": "Try a more specific address, e.g. 'Badlapur West, Thane' or 'Karjat Station Road'",
        }
    )


async def _geocode_priority_stops(stops: List[PriorityStopObj]) -> List[Tuple[float, float]]:
    """
    Geocode all priority stops concurrently.
    Stops that fail to resolve are silently skipped (logged as warning).
    Returns list of (lat, lon) tuples in original order.
    """
    if not stops:
        return []

    async def _resolve_one(stop: PriorityStopObj) -> Optional[Tuple[float, float]]:
        if stop.lat is not None and stop.lon is not None:
            # Already have coordinates, just snap them
            try:
                return await snap_to_road(stop.lat, stop.lon)
            except Exception as exc:
                logger.warning("Priority stop road snapping failed for '%s': %s", stop.label, exc)
                return stop.lat, stop.lon

        try:
            results = await geocode(stop.label, limit=1, snap=True)
            if results:
                return results[0]["lat"], results[0]["lon"]
        except Exception as exc:
            logger.warning("Priority stop geocoding failed for '%s': %s", stop.label, exc)
        return None

    results = await asyncio.gather(*[_resolve_one(s) for s in stops])
    coords = [r for r in results if r is not None]
    if len(coords) < len(stops):
        logger.warning(
            "%d/%d priority stops could not be geocoded",
            len(stops) - len(coords), len(stops)
        )
    return coords


# ──────────────────────────────────────────────────────────────────────────────
# POST /optimize-route
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/optimize-route", summary="Generate and rank optimised routes")
@limiter.limit("5/minute")
async def optimize_route(request: Request, req: OptimizeRouteRequest):
    t_start = time.perf_counter()

    # ── 1. Resolve source / destination coordinates ───────────────────────────
    try:
        s_lat, s_lon = await _resolve_coords(req.source, req.source_lat, req.source_lon)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Source resolution error: {exc}")

    try:
        d_lat, d_lon = await _resolve_coords(req.destination, req.dest_lat, req.dest_lon)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Destination resolution error: {exc}")

    # ── 2. Geocode priority stops ─────────────────────────────────────────────
    priority_coords = await _geocode_priority_stops(req.priority_stops or [])

    # ── 3. Vehicle attributes ─────────────────────────────────────────────────
    vehicle_info = _lookup_vehicle(req.vehicle_type, req.vehicle_brand, req.vehicle_model)
    mileage   = float(req.mileage or vehicle_info.get("mileage", 18.0)) or 18.0
    fuel_type = req.fuel_type or vehicle_info.get("fuel_type", "petrol")

    # ── 4. Weather data ───────────────────────────────────────────────────────
    weather_data = await get_weather_data(req.source)

    # ── 5. Generate OSRM routes ───────────────────────────────────────────────
    try:
        paths = await get_dynamic_routes(
            slat=s_lat, slon=s_lon,
            dlat=d_lat, dlon=d_lon,
            priority_coords=priority_coords,
            top_k=req.top_k,
            optimize_stops=req.optimize_stops
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "error": str(exc),
                "retry_hint": "No navigable roads found between these points. Try different locations.",
            }
        )
    except Exception as exc:
        logger.error("OSRM route generation error: %s", exc, exc_info=True)
        raise HTTPException(500, f"Route engine error: {exc}")

    if not paths:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "No route found between source and destination.",
                "retry_hint": "Try adjusting your source/destination or check road connectivity.",
            }
        )

    # ── 6. Feature computation ────────────────────────────────────────────────
    features_list = batch_compute_features(
        routes=paths,
        weather_data=weather_data,
        vehicle_type=req.vehicle_type,
        mileage=mileage,
        fuel_type=fuel_type,
        mode=req.mode,
        priority_stops=[s.label for s in req.priority_stops] if req.priority_stops else None,
    )

    # ── 7. ML predictions ─────────────────────────────────────────────────────
    try:
        fvecs    = np.array([features_to_vector(f) for f in features_list])
        ml_preds = predict(fvecs)
    except Exception as exc:
        logger.warning("ML prediction failed: %s", exc)
        ml_preds = None

    # ── 8. Score & rank ───────────────────────────────────────────────────────
    scored = score_routes(features_list, mode=req.mode, ml_predictions=ml_preds)

    best         = scored[0]
    alternatives = scored[1:4]
    savings      = compute_savings(best, scored[1]) if len(scored) > 1 else {}

    # ── 9. Create re-routing session ──────────────────────────────────────────
    session_params = {
        "source":        req.source,
        "destination":   req.destination,
        "source_lat":    s_lat,   "source_lon":  s_lon,
        "dest_lat":      d_lat,   "dest_lon":    d_lon,
        "priority_coords": priority_coords,
        "vehicle_type":  req.vehicle_type,
        "vehicle_model": req.vehicle_model or "",
        "mileage":       mileage,
        "fuel_type":     fuel_type,
        "priority_stops": [s.label for s in req.priority_stops] if req.priority_stops else [],
        "mode":          req.mode,
    }
    session_id = create_session(session_params)
    update_session_best(session_id, best["composite_score"], best["path"])

    elapsed = round(time.perf_counter() - t_start, 3)

    # ── 10. Traffic data (for context summary) ────────────────────────────────
    try:
        traffic_data = await get_traffic_data(req.source, req.destination)
    except Exception:
        traffic_data = {"_source": "unavailable"}

    return {
        "success":            True,
        "session_id":         session_id,
        "computation_time_s": elapsed,
        "routes_evaluated":   len(scored),
        "source":             req.source,
        "destination":        req.destination,
        "source_coords":      {"lat": s_lat, "lon": s_lon},
        "dest_coords":        {"lat": d_lat, "lon": d_lon},
        "priority_stops_resolved": len(priority_coords),
        "mode":               req.mode,
        "vehicle": {
            "type":      req.vehicle_type,
            "brand":     req.vehicle_brand,
            "model":     req.vehicle_model,
            "mileage":   mileage,
            "fuel_type": fuel_type,
        },
        "context": {
            "traffic": traffic_summary(traffic_data),
            "weather": weather_summary(weather_data),
        },
        "best_route":         _serialise_route(best),
        "alternative_routes": [_serialise_route(a) for a in alternatives],
        "savings":            savings,
        "all_routes_summary": [
            {
                "rank":               s["rank"],
                "composite_score":    s["composite_score"],
                "distance_km":        s["distance_km"],
                "estimated_time_min": s["estimated_time_min"],
                "fuel_estimate":      s["fuel_estimate"],
                **{k: v for k, v in _serialise_route(s).items()
                   if k in {"path_geometry", "segments"}},
            }
            for s in scored
        ],
    }


# ──────────────────────────────────────────────────────────────────────────────
# GET /routes/autocomplete
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/routes/autocomplete", summary="Geocode / autocomplete an address")
async def autocomplete(q: str):
    if not q or len(q.strip()) < 2:
        return {"results": []}
    results = await geocode(q, limit=5, snap=False)  # No snap for autocomplete (speed)
    return {"results": results}


# ──────────────────────────────────────────────────────────────────────────────
# GET /routes/nodes  (legacy compatibility)
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/routes/nodes", summary="List all graph nodes (legacy)")
def list_nodes():
    nodes = get_all_nodes()
    return {
        "count": len(nodes),
        "nodes": [{"name": n, **node_info(n)} for n in nodes],
    }


# ──────────────────────────────────────────────────────────────────────────────
# GET /routes/vehicles
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/routes/vehicles", summary="List vehicle database")
def list_vehicles():
    return _load_vehicle_db()


@router.get("/routes/vehicles/{vehicle_type}", summary="List vehicles by type")
def list_vehicles_by_type(vehicle_type: str):
    db = _load_vehicle_db()
    vtype_map = {"bike": "bikes", "car": "cars", "truck": "trucks", "tempo": "tempos"}
    key = vtype_map.get(vehicle_type.lower())
    if not key or key not in db:
        raise HTTPException(404, f"Unknown vehicle type: {vehicle_type}")
    return db[key]


# ──────────────────────────────────────────────────────────────────────────────
# Session endpoints
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/routes/session/{session_id}", summary="Get session info")
def get_session_info(session_id: str):
    sess = get_session(session_id)
    if not sess:
        raise HTTPException(404, "Session not found or expired.")
    return {
        "session_id":         sess.session_id,
        "source":             sess.source,
        "destination":        sess.destination,
        "vehicle_type":       sess.vehicle_type,
        "mode":               sess.mode,
        "current_best_score": sess.current_best_score,
        "current_best_path":  sess.current_best_path,
        "created_at":         sess.created_at,
        "last_seen":          sess.last_seen,
        "active_callbacks":   len(sess.callbacks),
    }


@router.delete("/routes/session/{session_id}", summary="Close a route session")
def close_session(session_id: str):
    if not get_session(session_id):
        raise HTTPException(404, "Session not found.")
    remove_session(session_id)
    return {"success": True, "message": f"Session {session_id} closed."}


# ──────────────────────────────────────────────────────────────────────────────
# GET /routes/model-metrics
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/routes/model-metrics", summary="ML model quality metrics")
def model_metrics():
    return get_model_metrics()


# ──────────────────────────────────────────────────────────────────────────────
# GET /routes/traffic-snapshot
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/routes/traffic-snapshot", summary="Current traffic snapshot")
async def traffic_snapshot():
    data = await get_traffic_data("CSMT", "Borivali")
    return {
        "summary":        traffic_summary(data),
        "node_densities": {k: v for k, v in data.items() if k != "_source"},
    }


# ──────────────────────────────────────────────────────────────────────────────
# GET /routes/weather-snapshot
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/routes/weather-snapshot", summary="Current weather conditions")
async def weather_snapshot():
    return await get_weather_data("CSMT")


# ──────────────────────────────────────────────────────────────────────────────
# WebSocket /ws/reroute/{session_id}
# ──────────────────────────────────────────────────────────────────────────────

@router.websocket("/ws/reroute/{session_id}")
async def websocket_reroute(websocket: WebSocket, session_id: str):
    await websocket.accept()
    logger.info("WS connected – session %s", session_id)

    sess = get_session(session_id)
    if not sess:
        await websocket.send_json({
            "event": "error",
            "message": f"Session {session_id} not found or expired.",
        })
        await websocket.close()
        return

    await websocket.send_json({
        "event":              "connected",
        "session_id":         session_id,
        "message":            "Monitoring for better routes. Updates pushed every 30s.",
        "current_best_score": sess.current_best_score,
    })

    async def _ws_sender(data: Dict[str, Any]):
        try:
            await websocket.send_json(data)
        except Exception:
            pass

    register_ws_callback(session_id, _ws_sender)

    try:
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=25.0)
                if msg.strip() == "ping":
                    await websocket.send_json({"event": "pong", "session_id": session_id})
                elif msg.strip() == "close":
                    break
            except asyncio.TimeoutError:
                await websocket.send_json({
                    "event":      "heartbeat",
                    "session_id": session_id,
                    "timestamp":  time.time(),
                })
    except WebSocketDisconnect:
        logger.info("WS disconnected – session %s", session_id)
    finally:
        if current_sess := get_session(session_id):
            try:
                current_sess.callbacks.remove(_ws_sender)
            except ValueError:
                pass
