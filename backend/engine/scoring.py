"""
scoring.py
Multi-criteria weighted scoring of candidate routes.

score = 0.30 * time   + 0.25 * traffic + 0.20 * fuel
      + 0.10 * weather + 0.10 * road   + 0.05 * priority

All raw features are min-max normalised before scoring so that different
units (km, minutes, litres) don't dominate.

Lower score = better route.
"""

from typing import List, Dict, Any, Tuple
import numpy as np

# ──────────────────────────────────────────────────────────────────────────────
# Scoring weights (must sum to 1.0)
# ──────────────────────────────────────────────────────────────────────────────
WEIGHTS = {
    "time":             0.30,
    "traffic":          0.25,
    "fuel":             0.20,
    "weather":          0.10,
    "road":             0.10,
    "priority":         0.05,
}

assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "Weights must sum to 1.0"

# ──────────────────────────────────────────────────────────────────────────────
# Eco mode overrides
# ──────────────────────────────────────────────────────────────────────────────
ECO_WEIGHTS = {
    "time":             0.15,
    "traffic":          0.20,
    "fuel":             0.45,   # Prioritise fuel savings
    "weather":          0.10,
    "road":             0.05,
    "priority":         0.05,
}


def _get_weights(mode: str) -> Dict[str, float]:
    return ECO_WEIGHTS if mode == "eco" else WEIGHTS


def _extract_raw(features_list: List[Dict[str, Any]]) -> np.ndarray:
    """
    Extract the 6 scoring dimensions from feature dicts into an (N, 6) matrix.

    Columns: [time, traffic, fuel, weather, road_penalty, priority]
    Note: road_quality_score is inverted → road_penalty = 1 - quality
    """
    N = len(features_list)
    mat = np.zeros((N, 6), dtype=np.float64)
    for i, f in enumerate(features_list):
        mat[i, 0] = f.get("estimated_time_min", 0.0)
        mat[i, 1] = f.get("traffic_density", 0.0)
        mat[i, 2] = f.get("fuel_estimate", 0.0)
        mat[i, 3] = f.get("weather_impact", 0.0)
        mat[i, 4] = 1.0 - f.get("road_quality_score", 0.5)   # inverted
        mat[i, 5] = f.get("priority_deviation", 0.0)
    return mat


def _minmax_normalize(mat: np.ndarray) -> np.ndarray:
    """
    Column-wise min-max normalisation → [0, 1].
    If a column is constant (max == min), set all values to 0.
    """
    result = np.zeros_like(mat)
    for col in range(mat.shape[1]):
        col_min = mat[:, col].min()
        col_max = mat[:, col].max()
        span = col_max - col_min
        if span > 1e-9:
            result[:, col] = (mat[:, col] - col_min) / span
        # else: stays 0 (all routes equal on this dimension)
    return result


def score_routes(
    features_list: List[Dict[str, Any]],
    mode: str = "fastest",
    ml_predictions: np.ndarray = None,
    ml_weight: float = 0.15,
) -> List[Dict[str, Any]]:
    """
    Score and rank all candidate routes.

    Parameters
    ----------
    features_list   : list of feature dicts from feature_engine
    mode            : 'fastest' | 'eco'
    ml_predictions  : optional array of ML-predicted cost/time per route
    ml_weight       : weight to blend ML score into final score

    Returns
    -------
    Sorted list of dicts (best first) with fields:
        rank, composite_score, score_breakdown, ml_score (if applicable),
        plus all original feature fields
    """
    if not features_list:
        return []

    weights = _get_weights(mode)
    w = np.array([
        weights["time"], weights["traffic"], weights["fuel"],
        weights["weather"], weights["road"], weights["priority"],
    ])

    raw = _extract_raw(features_list)
    norm = _minmax_normalize(raw)

    # Weighted composite score (lower = better)
    composite_scores = norm @ w   # shape (N,)

    # Blend ML predictions if supplied
    if ml_predictions is not None and len(ml_predictions) == len(features_list):
        ml_norm = _minmax_normalize(ml_predictions.reshape(-1, 1)).ravel()
        composite_scores = (1 - ml_weight) * composite_scores + ml_weight * ml_norm

    # Assemble output
    scored = []
    dim_names = ["time", "traffic", "fuel", "weather", "road_penalty", "priority"]
    for i, feat in enumerate(features_list):
        breakdown = {
            dim: round(float(norm[i, j]), 4)
            for j, dim in enumerate(dim_names)
        }
        entry = {
            **feat,
            "composite_score": round(float(composite_scores[i]), 6),
            "score_breakdown": breakdown,
        }
        if ml_predictions is not None and len(ml_predictions) == len(features_list):
            entry["ml_predicted_cost"] = round(float(ml_predictions[i]), 4)
        scored.append(entry)

    # Sort ascending by composite score (best route first)
    scored.sort(key=lambda x: x["composite_score"])

    # Assign ranks
    for rank, entry in enumerate(scored, start=1):
        entry["rank"] = rank

    return scored


def compute_savings(best: Dict[str, Any], baseline: Dict[str, Any]) -> Dict[str, Any]:
    """
    Compute time and fuel savings comparing best route vs baseline (rank-2 or current route).
    """
    time_saved = round(baseline.get("estimated_time_min", 0) - best.get("estimated_time_min", 0), 2)
    fuel_saved = round(baseline.get("fuel_estimate", 0) - best.get("fuel_estimate", 0), 4)
    pct_time = round((time_saved / max(baseline.get("estimated_time_min", 1), 1)) * 100, 1)
    pct_fuel = round((fuel_saved / max(baseline.get("fuel_estimate", 0.001), 0.001)) * 100, 1)

    return {
        "time_saved_min": max(time_saved, 0.0),
        "time_saved_pct": max(pct_time, 0.0),
        "fuel_saved":     max(fuel_saved, 0.0),
        "fuel_saved_pct": max(pct_fuel, 0.0),
    }
