"""
ml_model.py
RandomForestRegressor trained on synthetic route data.
Predicts delivery cost/time given the 8-feature route vector.

This module:
  1. Generates synthetic training data (1500 samples)
  2. Trains a RandomForestRegressor
  3. Exposes predict() for inference at route-selection time
  4. Persists the model to disk and reloads on startup
"""

import os
import logging
import pickle
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import mean_absolute_error, r2_score

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Paths
# ──────────────────────────────────────────────────────────────────────────────
_DIR = Path(__file__).parent.parent / "data"
MODEL_PATH = _DIR / "rf_model.pkl"

# ──────────────────────────────────────────────────────────────────────────────
# Feature column names (must match features_to_vector in feature_engine.py)
# ──────────────────────────────────────────────────────────────────────────────
FEATURE_COLS = [
    "distance_km",
    "estimated_time_min",
    "traffic_density",
    "signals_count",
    "fuel_estimate",
    "weather_impact",
    "road_quality_score",
    "priority_deviation",
]

# ──────────────────────────────────────────────────────────────────────────────
# Synthetic data generation
# ──────────────────────────────────────────────────────────────────────────────

def _generate_training_data(n_samples: int = 2000, seed: int = 0) -> pd.DataFrame:
    """
    Generate synthetic route feature data with a realistic target
    (delivery_cost = weighted combination of features + noise).
    """
    rng = np.random.default_rng(seed)

    distance_km        = rng.uniform(2.0, 60.0, n_samples)
    estimated_time_min = distance_km * rng.uniform(1.5, 4.5, n_samples)  # plausible
    traffic_density    = rng.uniform(0.0, 1.0, n_samples)
    signals_count      = (distance_km * rng.uniform(0.5, 2.5, n_samples)).astype(int)
    fuel_estimate      = distance_km / rng.uniform(8.0, 70.0, n_samples)
    weather_impact     = rng.uniform(0.0, 0.9, n_samples)
    road_quality_score = rng.uniform(0.3, 1.0, n_samples)
    priority_deviation = rng.uniform(0.0, 1.0, n_samples)

    # Target: composite delivery cost (₹) – domain-inspired formula
    delivery_cost = (
        estimated_time_min * 1.5            # time ₹1.5/min
        + fuel_estimate * 102.0             # petrol ₹102/L
        + traffic_density * 30.0            # congestion penalty
        + signals_count * 0.5               # signal penalty
        + (1 - road_quality_score) * 20.0  # bad road penalty
        + weather_impact * 25.0             # weather penalty
        + priority_deviation * 40.0         # missed stop penalty
        + rng.normal(0, 3.0, n_samples)    # noise
    )
    delivery_cost = np.clip(delivery_cost, 5.0, None)

    df = pd.DataFrame({
        "distance_km": distance_km,
        "estimated_time_min": estimated_time_min,
        "traffic_density": traffic_density,
        "signals_count": signals_count.astype(float),
        "fuel_estimate": fuel_estimate,
        "weather_impact": weather_impact,
        "road_quality_score": road_quality_score,
        "priority_deviation": priority_deviation,
        "delivery_cost": delivery_cost,
    })
    return df


# ──────────────────────────────────────────────────────────────────────────────
# Model training
# ──────────────────────────────────────────────────────────────────────────────

def train_model(force_retrain: bool = False) -> Pipeline:
    """
    Train (or load from disk) the RandomForest pipeline.
    Returns the fitted Pipeline(scaler + RF).
    """
    if MODEL_PATH.exists() and not force_retrain:
        logger.info("Loading cached ML model from %s", MODEL_PATH)
        with open(MODEL_PATH, "rb") as f:
            return pickle.load(f)

    logger.info("Training RandomForestRegressor on synthetic data …")
    df = _generate_training_data(n_samples=2000)

    X = df[FEATURE_COLS].values
    y = df["delivery_cost"].values

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("rf", RandomForestRegressor(
            n_estimators=150,
            max_depth=12,
            min_samples_leaf=3,
            n_jobs=-1,
            random_state=42,
        )),
    ])

    pipeline.fit(X_train, y_train)

    # Evaluate
    y_pred = pipeline.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2  = r2_score(y_test, y_pred)
    logger.info("ML Model – MAE: %.2f  R²: %.3f", mae, r2)

    # Persist
    _DIR.mkdir(parents=True, exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(pipeline, f)
    logger.info("Model saved to %s", MODEL_PATH)

    return pipeline


# ──────────────────────────────────────────────────────────────────────────────
# Singleton
# ──────────────────────────────────────────────────────────────────────────────
_MODEL: Optional[Pipeline] = None


def get_model() -> Pipeline:
    global _MODEL
    if _MODEL is None:
        _MODEL = train_model()
    return _MODEL


def predict(feature_vectors: np.ndarray) -> np.ndarray:
    """
    Predict delivery cost for a batch of route feature vectors.

    Parameters
    ----------
    feature_vectors : (N, 8) numpy array

    Returns
    -------
    (N,) numpy array of predicted costs
    """
    model = get_model()
    if feature_vectors.ndim == 1:
        feature_vectors = feature_vectors.reshape(1, -1)
    return model.predict(feature_vectors)


def get_model_metrics() -> dict:
    """Return training quality metrics (re-evaluated on fresh synthetic data)."""
    model = get_model()
    df = _generate_training_data(n_samples=500, seed=99)
    X = df[FEATURE_COLS].values
    y = df["delivery_cost"].values
    y_pred = model.predict(X)
    return {
        "mae":  round(float(mean_absolute_error(y, y_pred)), 4),
        "r2":   round(float(r2_score(y, y_pred)), 4),
        "n_estimators": model.named_steps["rf"].n_estimators,
        "feature_importances": {
            col: round(float(imp), 4)
            for col, imp in zip(
                FEATURE_COLS, model.named_steps["rf"].feature_importances_
            )
        },
    }
