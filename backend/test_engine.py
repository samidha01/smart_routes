"""
test_engine.py
Quick integration test – runs without a live server.
Execute from the backend/ directory:
    python test_engine.py
"""

import asyncio
import sys
import time

# ── Colour helpers ─────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"

def ok(msg):    print(f"  {GREEN}[OK]{RESET}  {msg}")
def fail(msg):  print(f"  {RED}[FAIL]{RESET}  {msg}"); sys.exit(1)
def info(msg):  print(f"  {CYAN}->{RESET}  {msg}")
def section(t): print(f"\n{YELLOW}{'-'*55}\n  {t}\n{'-'*55}{RESET}")


# ──────────────────────────────────────────────────────────────────────────────
# 1. Graph builder
# ──────────────────────────────────────────────────────────────────────────────
section("1 · Graph Builder")

from engine.graph_builder import build_city_graph, get_all_nodes
import networkx as nx

t0 = time.perf_counter()
G = build_city_graph()
elapsed = round(time.perf_counter() - t0, 3)

nodes = G.number_of_nodes()
edges = G.number_of_edges()
info(f"Built in {elapsed}s  ->  {nodes} nodes, {edges} edges")

assert nodes >= 70,  "Expected ≥70 nodes"
assert edges >= 300, "Expected ≥300 edges"
ok(f"Graph has {nodes} nodes and {edges} edges")

is_conn = nx.is_strongly_connected(G)
if is_conn:
    ok("Graph is strongly connected")
else:
    n_comp = nx.number_strongly_connected_components(G)
    info(f"Graph has {n_comp} strongly connected components (acceptable)")


# ──────────────────────────────────────────────────────────────────────────────
# 2. K-Shortest paths
# ──────────────────────────────────────────────────────────────────────────────
section("2 · K-Shortest Paths")

from engine.k_shortest import generate_k_shortest_paths, dijkstra_shortest

SRC = "CSMT"
DST = "Borivali"
info(f"Source: {SRC}  ->  Dest: {DST}")

t0 = time.perf_counter()
paths = generate_k_shortest_paths(G, SRC, DST, k=50)
elapsed = round(time.perf_counter() - t0, 3)

info(f"Generated {len(paths)} paths in {elapsed}s")
assert len(paths) >= 1, "Should find at least 1 path"
ok(f"{len(paths)} candidate routes generated")

# Convert paths to route dicts
route_dicts = []
for path in paths:
    distance = 0.0
    duration = 0.0
    for i in range(len(path)-1):
        u, v = path[i], path[i+1]
        edge_data = G.get_edge_data(u, v)
        if edge_data:
            distance += edge_data.get("distance", 0.0)
            duration += edge_data.get("base_time_min", 0.0) * 60
    osrm_route = {
        "distance": distance * 1000,
        "duration": duration,
        "geometry": {"coordinates": []}
    }
    route_dicts.append(osrm_route)

dijk = dijkstra_shortest(G, SRC, DST)
assert dijk is not None, "Dijkstra should find a path"
ok(f"Dijkstra found path  (length={len(dijk)} nodes)")


# ──────────────────────────────────────────────────────────────────────────────
# 3. Traffic & Weather services
# ──────────────────────────────────────────────────────────────────────────────
section("3 · Traffic & Weather Services")

from services.traffic_api import get_traffic_data, traffic_summary
from services.weather_api import get_weather_data, weather_summary

traffic_data = asyncio.run(get_traffic_data(SRC, DST))
assert "_source" in traffic_data
ok(f"Traffic data  [{traffic_data['_source']}]  -  {traffic_summary(traffic_data)}")

weather_data = asyncio.run(get_weather_data(SRC))
assert "severity" in weather_data
ok(f"Weather data  [{weather_data['_source']}]  -  {weather_summary(weather_data)}")


# ──────────────────────────────────────────────────────────────────────────────
# 4. Feature Engine
# ──────────────────────────────────────────────────────────────────────────────
section("4 · Feature Engine")

from engine.feature_engine import batch_compute_features, features_to_vector
import numpy as np

t0 = time.perf_counter()
features_list = batch_compute_features(
    route_dicts, weather_data,
    vehicle_type="car",
    mileage=18.0,
    fuel_type="petrol",
    priority_stops=["Dadar"],
    mode="fastest",
)
elapsed = round(time.perf_counter() - t0, 3)

assert len(features_list) == len(paths)
ok(f"Features computed for {len(features_list)} routes in {elapsed}s")

f0 = features_list[0]
info(f"Sample - dist={f0['distance_km']}km  time={f0['estimated_time_min']}min  "
     f"traffic={f0['traffic_density']}  fuel={f0['fuel_estimate']}L")

vec = features_to_vector(f0)
assert len(vec) == 8, f"Expected 8-dim vector, got {len(vec)}"
ok(f"Feature vector shape: {len(vec)}")


# ------------------------------------------------------------------------------
# 5. Scoring
# ------------------------------------------------------------------------------
section("5 - Scoring Engine")

from engine.scoring import score_routes, compute_savings

scored = score_routes(features_list, mode="fastest")
assert len(scored) == len(features_list)
assert scored[0]["rank"] == 1
ok(f"Scored {len(scored)} routes")

best = scored[0]
info(f"Best route  -  score={best['composite_score']}  "
     f"dist={best['distance_km']}km  time={best['estimated_time_min']}min")
info(f"  Breakdown: {best['score_breakdown']}")

# Eco mode
scored_eco = score_routes(features_list, mode="eco")
ok(f"Eco scoring succeeded (best score={scored_eco[0]['composite_score']})")

if len(scored) > 1:
    savings = compute_savings(best, scored[1])
    ok(f"Savings computed: time_saved={savings['time_saved_min']}min, "
       f"fuel_saved={savings['fuel_saved']}L")


# ──────────────────────────────────────────────────────────────────────────────
# 6. ML Model
# ──────────────────────────────────────────────────────────────────────────────
section("6 · ML Model (RandomForestRegressor)")

from engine.ml_model import train_model, predict, get_model_metrics

t0 = time.perf_counter()
model = train_model()
elapsed = round(time.perf_counter() - t0, 3)
ok(f"Model ready in {elapsed}s")

fvecs = np.array([features_to_vector(f) for f in features_list])
preds = predict(fvecs)
assert preds.shape == (len(features_list),)
info(f"Predictions (first 5): {preds[:5].round(2)}")
ok(f"ML predictions for {len(preds)} routes")

metrics = get_model_metrics()
ok(f"Model metrics  -  MAE={metrics['mae']}  R2={metrics['r2']}")
info(f"Feature importances: {metrics['feature_importances']}")

# Score with ML blended
scored_ml = score_routes(features_list, mode="fastest", ml_predictions=preds, ml_weight=0.15)
ok(f"ML-blended scoring: top route score={scored_ml[0]['composite_score']}")


# ──────────────────────────────────────────────────────────────────────────────
# 7. Full pipeline timing
# ──────────────────────────────────────────────────────────────────────────────
section("7 · Full Pipeline End-to-End Timing")

t_total = time.perf_counter()
paths_new  = generate_k_shortest_paths(G, "Bandra_West", "Thane", k=50)
# Convert to route dicts
route_dicts_new = []
for path in paths_new:
    distance = 0.0
    duration = 0.0
    for i in range(len(path)-1):
        u, v = path[i], path[i+1]
        edge_data = G.get_edge_data(u, v)
        if edge_data:
            distance += edge_data.get("distance", 0.0)
            duration += edge_data.get("base_time_min", 0.0) * 60
    osrm_route = {
        "distance": distance * 1000,
        "duration": duration,
        "geometry": {"coordinates": []}
    }
    route_dicts_new.append(osrm_route)
td_new     = asyncio.run(get_traffic_data("Bandra_West", "Thane"))
wd_new     = asyncio.run(get_weather_data("Bandra_West"))
feats_new  = batch_compute_features(route_dicts_new, wd_new, vehicle_type="truck", mileage=8.0, fuel_type="diesel", priority_stops=[], mode="eco")
fv_new     = np.array([features_to_vector(f) for f in feats_new])
ml_new     = predict(fv_new)
sc_new     = score_routes(feats_new, mode="eco", ml_predictions=ml_new)
elapsed_total = round(time.perf_counter() - t_total, 3)

ok(f"Bandra_West -> Thane: {len(sc_new)} routes in {elapsed_total}s")
info(f"  Best route: {sc_new[0]['path'][:4]}... (score={sc_new[0]['composite_score']})")


# ──────────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────────
print(f"\n{GREEN}{'='*55}")
print(f"  ALL TESTS PASSED  ")
print(f"{'='*55}{RESET}\n")
