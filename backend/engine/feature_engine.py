import math
import random
import numpy as np
from typing import List, Dict, Any, Optional
from services.traffic_api import get_segment_traffic

# Fuel constants
DEFAULT_MILEAGE = {
    "bike": 45.0,
    "car": 18.0,
    "truck": 8.0,
    "tempo": 20.0,
}
FUEL_ENERGY_KWH_PER_KM = 0.15

def _traffic_factor(traffic_density: float) -> float:
    return round(1.0 + (traffic_density ** 1.5) * 1.5, 4)

def _weather_factor(weather_impact: float) -> float:
    return round(1.0 + weather_impact * 0.25, 4)

def _compute_fuel(distance_km, mileage, fuel_type, vehicle_type, traffic_factor, weather_severity, mode):
    if mileage <= 0:
        mileage = DEFAULT_MILEAGE.get(vehicle_type, 18.0)
    eff_mileage = mileage / traffic_factor
    eff_mileage *= (1.0 - weather_severity * 0.10)
    if mode == "eco": eff_mileage *= 1.10
    
    if fuel_type == "electric":
        return round(distance_km * FUEL_ENERGY_KWH_PER_KM * traffic_factor, 4)
    return round(distance_km / eff_mileage, 4)

def compute_route_features(
    osrm_route: Dict,
    weather_data: Dict[str, Any],
    vehicle_type: str,
    mileage: float,
    fuel_type: str,
    priority_stops: Optional[List[str]] = None,
    mode: str = "fastest",
) -> Dict[str, Any]:
    distance_km = osrm_route.get("distance", 0.0) / 1000.0
    base_time_min = osrm_route.get("duration", 0.0) / 60.0
    geom = osrm_route.get("geometry", {}).get("coordinates", [])
    
    traffic_densities = []
    if len(geom) > 1:
        step = max(1, len(geom) // 15)
        for i in range(0, len(geom)-1, step):
            p1 = geom[i]; p2 = geom[min(i+step, len(geom)-1)]
            td = get_segment_traffic(p1[1], p1[0], p2[1], p2[0])
            traffic_densities.append(td)
            
    traffic_density = round(float(np.mean(traffic_densities)), 4) if traffic_densities else 0.5
    tf = _traffic_factor(traffic_density)
    
    total_signals = int(distance_km * random.uniform(0.5, 2.0))
    road_quality = random.uniform(0.6, 0.95)
    ws = float(weather_data.get("severity", 0.0))
    wf = _weather_factor(ws)

    return {
        "distance_km": round(distance_km, 3),
        "estimated_time_min": round(base_time_min * tf * wf, 2),
        "base_time_min": round(base_time_min, 2),
        "traffic_density": traffic_density,
        "signals_count": total_signals,
        "fuel_estimate": _compute_fuel(distance_km, mileage, fuel_type, vehicle_type, tf, ws, mode),
        "weather_impact": round(ws, 4),
        "road_quality_score": road_quality,
        "priority_deviation": 0.0,
        "path": geom,
        "segment_traffic": traffic_densities,
        "node_count": len(geom),
        "edge_count": max(0, len(geom)-1),
        "traffic_factor": tf,
        "weather_factor": wf,
        "weather_condition": weather_data.get("condition", "clear"),
        "road_type_breakdown": {"arterial": 1.0},
    }

def batch_compute_features(
    routes: List[Dict],
    weather_data: Dict[str, Any],
    vehicle_type: str = "car",
    mileage: float = 15.0,
    fuel_type: str = "petrol",
    mode: str = "fastest",
    priority_stops: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    return [
        compute_route_features(r, weather_data, vehicle_type, mileage, fuel_type, priority_stops, mode)
        for r in routes
    ]

def features_to_vector(f: Dict[str, Any]) -> List[float]:
    return [
        f["distance_km"], f["estimated_time_min"], f["traffic_density"],
        f["signals_count"], f["fuel_estimate"], f["weather_impact"],
        f["road_quality_score"], f["priority_deviation"]
    ]
