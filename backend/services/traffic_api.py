"""
traffic_api.py
Fetches real-time traffic density data per road segment, OR uses a smart simulation mode.
"""

import asyncio
import logging
import math
import random
import time
from datetime import datetime
from typing import Dict, Any
import os

logger = logging.getLogger(__name__)

TRAFFIC_API_KEY  = os.getenv("TRAFFIC_API_KEY", "")
TRAFFIC_API_BASE = "https://api.here.com/traffic/6.3/flow.json"

# We use caching for spatial continuity in simulation
_SIM_CACHE = {}
_LAST_SIM_TIME = 0
_MODE_LOGGED = False

def _get_time_factor(hour: int) -> float:
    """Returns a base congestion multiplier based on Mumbai traffic patterns."""
    if 8 <= hour <= 11:
        return 0.85 # Morning peak
    elif 17 <= hour <= 21:
        return 0.90 # Evening peak
    elif 12 <= hour <= 16:
        return 0.50 # Afternoon
    elif 0 <= hour <= 5:
        return 0.10 # Night
    else:
        return 0.35 # Default

def _get_road_factor(road_type: str) -> float:
    """Highways handle traffic better than local roads (relative to capacity)."""
    return {
        "highway": 0.3,
        "expressway": 0.2,
        "arterial": 0.6,
        "collector": 0.7,
        "local": 0.8,
        "service": 0.9,
    }.get(road_type, 0.5)

async def _fetch_real_traffic(source: str, destination: str) -> Dict[str, float]:
    # Placeholder for real HTTP call using httpx
    # In a real scenario, we would use bounding box and fetch flow data.
    await asyncio.sleep(0.5)
    raise NotImplementedError("Real HERE Traffic API integration requires HTTP client setup.")

async def _simulated_traffic() -> Dict[str, float]:
    """Smart simulation using time of day, road type, and spatial clustering."""
    global _SIM_CACHE, _LAST_SIM_TIME
    
    current_time = time.time()
    # Fluctuate slowly every 20-30 seconds
    if current_time - _LAST_SIM_TIME < 25 and _SIM_CACHE:
        return _SIM_CACHE

    hour = datetime.now().hour
    time_factor = _get_time_factor(hour)
    
    from engine.graph_builder import get_graph
    G = get_graph()
    
    traffic: Dict[str, float] = {}
    
    # Create clusters of congestion based on zones
    zones = ["south", "central", "western", "eastern", "harbour", "mumbai_metro", "junction"]
    # Pick a few zones to be heavily congested based on time factor
    k = max(1, int(len(zones) * time_factor))
    congested_zones = random.sample(zones, k=k)
    
    for u, v, data in G.edges(data=True):
        edge_key = f"{u}→{v}"
        
        road_type = data.get("road_type", "arterial")
        road_factor = _get_road_factor(road_type)
        
        zone = G.nodes[u].get("zone", "unknown")
        zone_factor = 1.3 if zone in congested_zones else 0.7
        
        # Base density calculation
        density = (time_factor * 0.4) + (road_factor * 0.4)
        density *= zone_factor
        
        # If we have a previous value, interpolate to prevent sudden jumps
        prev = _SIM_CACHE.get(edge_key, density)
        density = (prev * 0.7) + (density * 0.3)
        
        # Add slight continuity random noise (-0.05 to 0.05)
        density += random.uniform(-0.05, 0.05)
        
        traffic[edge_key] = round(max(0.0, min(1.0, density)), 3)

    _SIM_CACHE = traffic
    _LAST_SIM_TIME = current_time
    return traffic

async def get_traffic_data(source: str, destination: str) -> Dict[str, Any]:
    global _MODE_LOGGED
    try:
        if not TRAFFIC_API_KEY:
            raise ValueError("No API key")
        data = await _fetch_real_traffic(source, destination)
        data["_source"] = "real_api"
        if not _MODE_LOGGED:
            logger.info("Running in REAL traffic mode")
            _MODE_LOGGED = True
        return data
    except Exception as exc:
        data = await _simulated_traffic()
        data["_source"] = "simulated"
        if not _MODE_LOGGED:
            logger.info("Running in SIMULATED traffic mode")
            _MODE_LOGGED = True
        return data

def traffic_summary(traffic_data: Dict[str, float]) -> Dict[str, Any]:
    values = [v for k, v in traffic_data.items() if k != "_source" and isinstance(v, float)]
    if not values:
        return {"avg": 0.5, "max": 1.0, "min": 0.0, "source": traffic_data.get("_source", "unknown")}
    return {
        "avg":    round(sum(values) / len(values), 3),
        "max":    round(max(values), 3),
        "min":    round(min(values), 3),
        "count":  len(values),
        "source": traffic_data.get("_source", "unknown"),
    }

def get_segment_traffic(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Spatial Traffic Simulator.
    Calculates traffic density for an arbitrary geographic segment based on:
    - Time of day (peaks)
    - Pseudo-random hash of the coordinates (so the same road is consistent)
    - Minor variation
    """
    # 1. Deterministic Hash of segment
    # Round to 3 decimals (~100m) so both directions get similar traffic
    s_lat, s_lon = round(min(lat1, lat2), 3), round(min(lon1, lon2), 3)
    e_lat, e_lon = round(max(lat1, lat2), 3), round(max(lon1, lon2), 3)
    
    seg_hash = hash(f"{s_lat},{s_lon}-{e_lat},{e_lon}")
    random.seed(seg_hash)
    
    # Base density for this road (0.2 to 0.8)
    base_density = random.uniform(0.2, 0.8)
    
    # 2. Time factor
    hour = datetime.now().hour
    
    time_multiplier = 1.0
    if 8 <= hour <= 11:    # Morning peak
        time_multiplier = 1.5
    elif 17 <= hour <= 21: # Evening peak
        time_multiplier = 1.6
    elif 1 <= hour <= 5:   # Night
        time_multiplier = 0.4
        
    # 3. Dynamic fluctuation (simulate slight live changes based on minute)
    # Seed with current minute / 10 (changes every 10 mins)
    fluctuation_seed = int(time.time() / 600) + seg_hash
    random.seed(fluctuation_seed)
    fluctuation = random.uniform(-0.15, 0.15)
    
    density = (base_density * time_multiplier) + fluctuation
    return max(0.1, min(density, 1.0))
