import os
import json
import time
import logging
import requests
import pathlib
from engine.graph_builder import get_graph, CITY_NODES

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("geometry")

DATA_DIR = pathlib.Path(__file__).parent.parent / "data"
GEO_CACHE_PATH = DATA_DIR / "edge_geometries.json"

def fetch_osrm_route(lon1, lat1, lon2, lat2):
    """Fetch route geometry from OSRM demo server."""
    url = f"https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson"
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("code") == "Ok" and len(data.get("routes", [])) > 0:
                # Return the array of [lon, lat] coordinates
                return data["routes"][0]["geometry"]["coordinates"]
    except Exception as e:
        logger.error(f"Error fetching OSRM: {e}")
    return None

def build_geometry_cache():
    """Iterates through all edges in the graph and caches their OSRM geometry."""
    G = get_graph()
    
    # Load existing cache to resume if interrupted
    cache = {}
    if GEO_CACHE_PATH.exists():
        try:
            with open(GEO_CACHE_PATH, "r", encoding="utf-8") as f:
                cache = json.load(f)
        except Exception:
            pass
            
    edges = list(G.edges())
    logger.info(f"Total edges to process: {len(edges)}")
    
    new_fetches = 0
    for i, (u, v) in enumerate(edges):
        edge_key = f"{u}->{v}"
        if edge_key in cache:
            continue
            
        node_u = CITY_NODES[u]
        node_v = CITY_NODES[v]
        
        lon1, lat1 = node_u["lon"], node_u["lat"]
        lon2, lat2 = node_v["lon"], node_v["lat"]
        
        coords = fetch_osrm_route(lon1, lat1, lon2, lat2)
        if coords:
            cache[edge_key] = coords
            new_fetches += 1
            logger.info(f"[{i+1}/{len(edges)}] Fetched geometry for {edge_key} ({len(coords)} points)")
        else:
            logger.warning(f"[{i+1}/{len(edges)}] Failed to fetch geometry for {edge_key}. Falling back to straight line.")
            cache[edge_key] = [[lon1, lat1], [lon2, lat2]]
            
        # Be nice to the public OSRM server
        time.sleep(0.3)
        
        # Save every 20 edges
        if new_fetches > 0 and new_fetches % 20 == 0:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            with open(GEO_CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(cache, f)
                
    # Final save
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(GEO_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f)
        
    logger.info(f"Done! Cached {len(cache)} edge geometries.")

def load_geometry_cache():
    if GEO_CACHE_PATH.exists():
        with open(GEO_CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

if __name__ == "__main__":
    build_geometry_cache()
