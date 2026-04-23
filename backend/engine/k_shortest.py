"""
k_shortest.py
Generates the top-K shortest simple paths between source and destination
using NetworkX's shortest_simple_paths (Yen's algorithm variant).
We use base_time_min as the primary edge weight for path enumeration.
"""

import networkx as nx
from networkx.algorithms.simple_paths import shortest_simple_paths
from typing import List, Dict, Generator, Optional
import itertools
import logging

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────
DEFAULT_K = 50          # Generate top-50 paths by default
MAX_K = 100             # Hard cap to avoid memory exhaustion
MIN_PATH_LEN = 2        # At least src → dst
MAX_PATH_LEN = 15       # Avoid unrealistically long winding routes
WEIGHT_ATTR = "base_time_min"


# ──────────────────────────────────────────────
# Path generation
# ──────────────────────────────────────────────

def generate_k_shortest_paths(
    G: nx.DiGraph,
    source: str,
    target: str,
    k: int = DEFAULT_K,
    weight: str = WEIGHT_ATTR,
) -> List[List[str]]:
    """
    Return up to *k* simple paths from source → target ordered by ascending
    total weight (base_time_min by default).

    Uses NetworkX shortest_simple_paths (Yen's k-shortest-paths algorithm).
    Falls back to Dijkstra single-path if fewer than k paths exist.

    Returns
    -------
    List of node sequences (each a List[str])
    """
    k = min(k, MAX_K)

    if source not in G:
        raise ValueError(f"Source node '{source}' not in graph.")
    if target not in G:
        raise ValueError(f"Target node '{target}' not in graph.")
    if source == target:
        raise ValueError("Source and target must be different nodes.")

    paths: List[List[str]] = []

    try:
        path_gen: Generator = shortest_simple_paths(G, source, target, weight=weight)
        for path in itertools.islice(path_gen, k * 3):   # fetch extra to allow filtering
            if MIN_PATH_LEN <= len(path) <= MAX_PATH_LEN:
                paths.append(path)
            if len(paths) >= k:
                break
    except nx.NetworkXNoPath:
        logger.warning("No path found between %s and %s", source, target)
        return []
    except nx.NodeNotFound as exc:
        raise ValueError(str(exc)) from exc

    # If we got fewer than requested, try alternate weights to surface more paths
    if len(paths) < k:
        paths = _supplement_with_alternate_weight(G, source, target, paths, k, weight)

    # De-duplicate (convert to frozensets of ordered tuples for identity)
    seen = set()
    unique: List[List[str]] = []
    for p in paths:
        key = tuple(p)
        if key not in seen:
            seen.add(key)
            unique.append(p)

    return unique[:k]


def _supplement_with_alternate_weight(
    G: nx.DiGraph,
    source: str,
    target: str,
    existing: List[List[str]],
    k: int,
    primary_weight: str,
) -> List[List[str]]:
    """
    When Yen's algorithm yields fewer than k paths,
    supplement by running it again with distance_km as weight
    and merging unique results.
    """
    alt_weight = "distance_km" if primary_weight != "distance_km" else "base_time_min"
    combined = list(existing)
    existing_keys = {tuple(p) for p in existing}

    try:
        gen = shortest_simple_paths(G, source, target, weight=alt_weight)
        for path in itertools.islice(gen, k * 2):
            key = tuple(path)
            if key not in existing_keys and MIN_PATH_LEN <= len(path) <= MAX_PATH_LEN:
                combined.append(path)
                existing_keys.add(key)
            if len(combined) >= k:
                break
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        pass

    return combined


def path_total_weight(G: nx.DiGraph, path: List[str], weight: str = WEIGHT_ATTR) -> float:
    """Sum the given edge attribute over all edges in the path."""
    total = 0.0
    for u, v in zip(path[:-1], path[1:]):
        data = G.get_edge_data(u, v)
        if data is None:
            return float("inf")
        total += data.get(weight, 0.0)
    return round(total, 4)


def path_edge_data(G: nx.DiGraph, path: List[str]) -> List[Dict]:
    """Return a list of edge attribute dicts for every segment in the path."""
    edges = []
    for u, v in zip(path[:-1], path[1:]):
        data = G.get_edge_data(u, v, default={})
        edges.append({"from": u, "to": v, **data})
    return edges


def dijkstra_shortest(G: nx.DiGraph, source: str, target: str) -> Optional[List[str]]:
    """
    Classic Dijkstra single-shortest path (time-based).
    Returns node list or None if no path exists.
    """
    try:
        return nx.dijkstra_path(G, source, target, weight=WEIGHT_ATTR)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None
