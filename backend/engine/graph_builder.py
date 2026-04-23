"""
graph_builder.py
Builds a rich weighted NetworkX graph representing an urban road network.
Nodes = named locations (junctions, landmarks, hubs).
Edges = road segments with attributes: distance_km, base_time_min, road_type, lanes, speed_limit.
"""

import networkx as nx
import random
import math
from typing import Dict, List, Tuple, Optional

# ──────────────────────────────────────────────
# Seed for reproducible graph generation
# ──────────────────────────────────────────────
RANDOM_SEED = 42
random.seed(RANDOM_SEED)

# ──────────────────────────────────────────────
# Road type meta-data
# ──────────────────────────────────────────────
ROAD_TYPE_PROPS = {
    "highway":     {"speed_limit": 100, "quality_score": 0.95, "lanes": 6},
    "expressway":  {"speed_limit": 120, "quality_score": 0.98, "lanes": 8},
    "arterial":    {"speed_limit": 60,  "quality_score": 0.80, "lanes": 4},
    "collector":   {"speed_limit": 40,  "quality_score": 0.65, "lanes": 2},
    "local":       {"speed_limit": 30,  "quality_score": 0.50, "lanes": 2},
    "service":     {"speed_limit": 20,  "quality_score": 0.40, "lanes": 1},
}

# ──────────────────────────────────────────────
# 80 canonical Mumbai city & suburban nodes with lat/lon
# ──────────────────────────────────────────────
CITY_NODES: Dict[str, Dict] = {
    # South Mumbai
    "CSMT":                   {"lat": 18.9400, "lon": 72.8350, "zone": "south"},
    "Churchgate":             {"lat": 18.9322, "lon": 72.8264, "zone": "south"},
    "Colaba":                 {"lat": 18.9067, "lon": 72.8147, "zone": "south"},
    "Nariman_Point":          {"lat": 18.9260, "lon": 72.8230, "zone": "south"},
    "Gateway_of_India":       {"lat": 18.9220, "lon": 72.8347, "zone": "south"},
    "Marine_Drive":           {"lat": 18.9440, "lon": 72.8228, "zone": "south"},
    "Malabar_Hill":           {"lat": 18.9548, "lon": 72.7955, "zone": "south"},
    "Cuffe_Parade":           {"lat": 18.9135, "lon": 72.8141, "zone": "south"},
    "Pedder_Road":            {"lat": 18.9710, "lon": 72.8080, "zone": "south"},
    "Haji_Ali":               {"lat": 18.9827, "lon": 72.8089, "zone": "south"},

    # Central Mumbai
    "Dadar":                  {"lat": 19.0178, "lon": 72.8478, "zone": "central"},
    "Worli":                  {"lat": 19.0169, "lon": 72.8166, "zone": "central"},
    "Lower_Parel":            {"lat": 18.9953, "lon": 72.8273, "zone": "central"},
    "Prabhadevi":             {"lat": 19.0166, "lon": 72.8265, "zone": "central"},
    "Mahim":                  {"lat": 19.0356, "lon": 72.8400, "zone": "central"},
    "Sion":                   {"lat": 19.0390, "lon": 72.8619, "zone": "central"},
    "Wadala":                 {"lat": 19.0213, "lon": 72.8649, "zone": "central"},
    "BKC":                    {"lat": 19.0655, "lon": 72.8656, "zone": "central"},
    "Parel":                  {"lat": 19.0019, "lon": 72.8383, "zone": "central"},
    "Matunga":                 {"lat": 19.0270, "lon": 72.8550, "zone": "central"},
    
    # Western Suburbs (South)
    "Bandra_West":            {"lat": 19.0596, "lon": 72.8295, "zone": "western"},
    "Bandra_East":            {"lat": 19.0601, "lon": 72.8450, "zone": "western"},
    "Khar":                    {"lat": 19.0691, "lon": 72.8332, "zone": "western"},
    "Santacruz":              {"lat": 19.0805, "lon": 72.8400, "zone": "western"},
    "Vile_Parle":             {"lat": 19.0991, "lon": 72.8453, "zone": "western"},
    "Juhu":                    {"lat": 19.1026, "lon": 72.8268, "zone": "western"},
    "Andheri_West":           {"lat": 19.1136, "lon": 72.8697, "zone": "western"},
    "Andheri_East":           {"lat": 19.1155, "lon": 72.8643, "zone": "western"},
    "Airport_T2":             {"lat": 19.0974, "lon": 72.8743, "zone": "western"},
    "Jogeshwari":             {"lat": 19.1380, "lon": 72.8499, "zone": "western"},
    
    # Western Suburbs (North)
    "Goregaon":               {"lat": 19.1643, "lon": 72.8493, "zone": "western"},
    "Malad":                   {"lat": 19.1830, "lon": 72.8497, "zone": "western"},
    "Kandivali":              {"lat": 19.2084, "lon": 72.8447, "zone": "western"},
    "Borivali":               {"lat": 19.2307, "lon": 72.8567, "zone": "western"},
    "Dahisar":                {"lat": 19.2505, "lon": 72.8665, "zone": "western"},
    "Mira_Road":              {"lat": 19.2841, "lon": 72.8698, "zone": "western"},
    "Bhayandar":              {"lat": 19.2974, "lon": 72.8519, "zone": "western"},

    # Eastern Suburbs
    "Kurla":                   {"lat": 19.0728, "lon": 72.8797, "zone": "eastern"},
    "Vidyavihar":             {"lat": 19.0792, "lon": 72.8988, "zone": "eastern"},
    "Ghatkopar":              {"lat": 19.0856, "lon": 72.9080, "zone": "eastern"},
    "Vikhroli":               {"lat": 19.1110, "lon": 72.9278, "zone": "eastern"},
    "Kanjurmarg":             {"lat": 19.1245, "lon": 72.9304, "zone": "eastern"},
    "Bhandup":                {"lat": 19.1413, "lon": 72.9348, "zone": "eastern"},
    "Mulund":                  {"lat": 19.1720, "lon": 72.9553, "zone": "eastern"},
    "Powai":                   {"lat": 19.1176, "lon": 72.9060, "zone": "eastern"},
    "Sakinaka":               {"lat": 19.1022, "lon": 72.8837, "zone": "eastern"},
    
    # Harbour / Eastern Suburbs
    "Chembur":                {"lat": 19.0522, "lon": 72.8996, "zone": "harbour"},
    "Mankhurd":               {"lat": 19.0494, "lon": 72.9307, "zone": "harbour"},
    "Deonar":                  {"lat": 19.0506, "lon": 72.9157, "zone": "harbour"},
    "Govandi":                {"lat": 19.0559, "lon": 72.9142, "zone": "harbour"},
    "Sewri":                   {"lat": 18.9950, "lon": 72.8550, "zone": "harbour"},
    "Byculla":                {"lat": 18.9760, "lon": 72.8327, "zone": "harbour"},
    "Sandhurst_Road":          {"lat": 18.9616, "lon": 72.8360, "zone": "harbour"},
    "Chunabhatti":            {"lat": 19.0496, "lon": 72.8687, "zone": "harbour"},

    # Navi Mumbai / Thane / Outskirts
    "Thane":                   {"lat": 19.2183, "lon": 72.9781, "zone": "mumbai_metro"},
    "Airoli":                  {"lat": 19.1583, "lon": 72.9972, "zone": "mumbai_metro"},
    "Ghansoli":               {"lat": 19.1256, "lon": 73.0016, "zone": "mumbai_metro"},
    "Kopar_Khairane":         {"lat": 19.1037, "lon": 73.0116, "zone": "mumbai_metro"},
    "Vashi":                   {"lat": 19.0771, "lon": 72.9986, "zone": "mumbai_metro"},
    "Sanpada":                {"lat": 19.0664, "lon": 73.0039, "zone": "mumbai_metro"},
    "Nerul":                   {"lat": 19.0345, "lon": 73.0152, "zone": "mumbai_metro"},
    "CBD_Belapur":            {"lat": 19.0180, "lon": 73.0401, "zone": "mumbai_metro"},
    "Kharghar":               {"lat": 19.0360, "lon": 73.0673, "zone": "mumbai_metro"},
    "Panvel":                  {"lat": 18.9894, "lon": 73.1175, "zone": "mumbai_metro"},

    # Major Sea Links & Bridges (Used as junctions)
    "BWSL_South_Toll":        {"lat": 19.0180, "lon": 72.8170, "zone": "junction"},
    "BWSL_North_Toll":        {"lat": 19.0460, "lon": 72.8200, "zone": "junction"},
    "Atal_Setu_Sewri":        {"lat": 18.9950, "lon": 72.8631, "zone": "junction"},
    "Atal_Setu_Nhava":        {"lat": 18.9056, "lon": 72.9942, "zone": "junction"},
    "Eastern_Freeway_Start":  {"lat": 18.9482, "lon": 72.8450, "zone": "junction"},
    "JVLR_East":              {"lat": 19.1221, "lon": 72.9304, "zone": "junction"},
    "JVLR_West":              {"lat": 19.1380, "lon": 72.8499, "zone": "junction"},
}


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Straight-line great-circle distance in km."""
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _road_type_for_distance(dist_km: float) -> str:
    if dist_km > 8:
        return random.choice(["highway", "expressway"])
    elif dist_km > 4:
        return random.choice(["highway", "arterial"])
    elif dist_km > 2:
        return random.choice(["arterial", "collector"])
    elif dist_km > 1:
        return random.choice(["collector", "local"])
    else:
        return random.choice(["local", "service"])


def _edge_attributes(u: str, v: str) -> Dict:
    lat1, lon1 = CITY_NODES[u]["lat"], CITY_NODES[u]["lon"]
    lat2, lon2 = CITY_NODES[v]["lat"], CITY_NODES[v]["lon"]

    straight_km = _haversine_km(lat1, lon1, lat2, lon2)
    # Road winding factor 1.1 – 1.5×
    road_factor = random.uniform(1.10, 1.50)
    distance_km = round(straight_km * road_factor, 3)

    road_type = _road_type_for_distance(distance_km)
    props = ROAD_TYPE_PROPS[road_type]

    speed_limit = props["speed_limit"]
    base_speed = speed_limit * random.uniform(0.6, 0.9)          # actual avg free-flow speed
    base_time_min = round((distance_km / base_speed) * 60, 2)    # minutes

    signals = max(0, int(distance_km * random.uniform(0.5, 2.0)))
    signal_delay = signals * random.uniform(0.5, 1.2)            # minutes

    return {
        "distance_km": distance_km,
        "base_time_min": round(base_time_min + signal_delay, 2),
        "road_type": road_type,
        "speed_limit": speed_limit,
        "lanes": props["lanes"],
        "quality_score": round(props["quality_score"] + random.uniform(-0.08, 0.04), 3),
        "signals_count": signals,
        "is_one_way": random.random() < 0.15,                   # 15% one-way roads
    }


def build_city_graph() -> nx.DiGraph:
    """
    Constructs a DiGraph with 80 nodes and ~400 directed edges.
    Edges are added based on geographic proximity and zone connectivity.
    """
    G = nx.DiGraph()

    # Add nodes
    for name, attrs in CITY_NODES.items():
        G.add_node(name, **attrs)

    nodes = list(CITY_NODES.keys())
    n = len(nodes)

    # ── Strategy: connect each node to K nearest neighbors ──
    K_INTRA = 5   # within same zone
    K_INTER = 3   # cross-zone bridges

    def nearest_nodes(source: str, candidates: List[str], k: int) -> List[str]:
        src = CITY_NODES[source]
        dists = []
        for c in candidates:
            if c == source:
                continue
            d = _haversine_km(src["lat"], src["lon"],
                               CITY_NODES[c]["lat"], CITY_NODES[c]["lon"])
            dists.append((d, c))
        dists.sort()
        return [c for _, c in dists[:k]]

    added_edges = set()

    for node in nodes:
        zone = CITY_NODES[node]["zone"]

        # Intra-zone
        same_zone = [n2 for n2 in nodes if CITY_NODES[n2]["zone"] == zone]
        for neighbor in nearest_nodes(node, same_zone, K_INTRA):
            if (node, neighbor) not in added_edges:
                attrs = _edge_attributes(node, neighbor)
                is_one_way = attrs.pop("is_one_way")
                G.add_edge(node, neighbor, **attrs)
                added_edges.add((node, neighbor))
                if not is_one_way:
                    rev = dict(attrs)
                    rev["base_time_min"] = round(rev["base_time_min"] * random.uniform(0.9, 1.1), 2)
                    G.add_edge(neighbor, node, **rev)
                    added_edges.add((neighbor, node))

        # Cross-zone bridges
        other_zone = [n2 for n2 in nodes if CITY_NODES[n2]["zone"] != zone]
        for neighbor in nearest_nodes(node, other_zone, K_INTER):
            if (node, neighbor) not in added_edges:
                attrs = _edge_attributes(node, neighbor)
                is_one_way = attrs.pop("is_one_way")
                G.add_edge(node, neighbor, **attrs)
                added_edges.add((node, neighbor))
                if not is_one_way:
                    rev = dict(attrs)
                    rev["base_time_min"] = round(rev["base_time_min"] * random.uniform(0.9, 1.1), 2)
                    G.add_edge(neighbor, node, **rev)
                    added_edges.add((neighbor, node))

    # ── Ensure full connectivity: add random long-range edges ──
    extra_count = 100
    for _ in range(extra_count):
        u, v = random.sample(nodes, 2)
        if (u, v) not in added_edges:
            attrs = _edge_attributes(u, v)
            attrs.pop("is_one_way")
            G.add_edge(u, v, **attrs)
            added_edges.add((u, v))

    _ensure_strong_connectivity(G, nodes)
    return G


def _ensure_strong_connectivity(G: nx.DiGraph, nodes: List[str]):
    """Add bridge edges until graph is strongly connected."""
    max_iter = 200
    for _ in range(max_iter):
        if nx.is_strongly_connected(G):
            break
        components = list(nx.strongly_connected_components(G))
        if len(components) == 1:
            break
        # Pick two random components and bridge them
        comp_a = list(random.choice(components))
        comp_b = list(random.choice([c for c in components if c != frozenset(comp_a)]))
        u = random.choice(comp_a)
        v = random.choice(comp_b)
        if not G.has_edge(u, v):
            attrs = _edge_attributes(u, v)
            attrs.pop("is_one_way")
            G.add_edge(u, v, **attrs)
        if not G.has_edge(v, u):
            attrs = _edge_attributes(v, u)
            attrs.pop("is_one_way")
            G.add_edge(v, u, **attrs)


# ──────────────────────────────────────────────
# Module-level singleton for fast access
# ──────────────────────────────────────────────
_GRAPH: Optional[nx.DiGraph] = None


def get_graph() -> nx.DiGraph:
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_city_graph()
    return _GRAPH


def get_all_nodes() -> List[str]:
    return list(CITY_NODES.keys())


def node_info(name: str) -> Optional[Dict]:
    return CITY_NODES.get(name)


def snap_to_nearest_node(lat: float, lon: float) -> str:
    """Finds the closest graph node to the given GPS coordinates."""
    best_node = None
    min_dist = float('inf')
    for name, attrs in CITY_NODES.items():
        n_lat, n_lon = attrs["lat"], attrs["lon"]
        dist = _haversine_km(lat, lon, n_lat, n_lon)
        if dist < min_dist:
            min_dist = dist
            best_node = name
    return best_node
