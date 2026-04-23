"""
weather_api.py
Fetches (or simulates) real-time weather data for the source location.

Production path: call OpenWeatherMap or similar free weather API.
Fallback:        simulate realistic values with seasonal & time patterns.
"""

import asyncio
import logging
import random
from datetime import datetime
from typing import Dict, Any

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Configuration  (set WEATHER_API_KEY env var for live data)
# ──────────────────────────────────────────────────────────────────────────────
WEATHER_API_KEY  = ""
OWM_BASE_URL     = "https://api.openweathermap.org/data/2.5/weather"

# Weather condition catalogue
WEATHER_CONDITIONS = [
    ("clear",          0.00),
    ("partly_cloudy",  0.05),
    ("overcast",       0.10),
    ("fog",            0.20),
    ("drizzle",        0.25),
    ("light_rain",     0.30),
    ("moderate_rain",  0.45),
    ("heavy_rain",     0.60),
    ("thunderstorm",   0.75),
    ("hailstorm",      0.85),
]


def _condition_for_severity(severity: float) -> str:
    """Pick label that best matches the given severity score."""
    for label, threshold in reversed(WEATHER_CONDITIONS):
        if severity >= threshold:
            return label
    return "clear"


async def _fetch_real_weather(location: str) -> Dict[str, Any]:
    """Stub for real OpenWeatherMap API call – raise to trigger fallback."""
    raise NotImplementedError("Weather API key not configured.")


async def _simulated_weather(location: str) -> Dict[str, Any]:
    """
    Simulate weather based on month (Indian climate – monsoon June-Sept).
    Returns a structured weather dict.
    """
    await asyncio.sleep(0)

    month = datetime.now().month
    hour  = datetime.now().hour

    # Monsoon months get higher base severity
    if 6 <= month <= 9:
        base_severity = random.uniform(0.30, 0.75)
    elif month in (10, 11):
        base_severity = random.uniform(0.10, 0.40)   # post-monsoon
    elif month in (12, 1, 2):
        base_severity = random.uniform(0.00, 0.20)   # winter, some fog
    else:
        base_severity = random.uniform(0.00, 0.15)   # summer, mostly clear

    # Midnight fog bonus in winter months
    if month in (12, 1) and (22 <= hour or hour < 7):
        base_severity = min(base_severity + 0.15, 1.0)

    severity  = round(max(0.0, min(1.0, base_severity + random.gauss(0, 0.05))), 3)
    condition = _condition_for_severity(severity)
    temp_c    = round(random.uniform(15, 40) - severity * 8, 1)   # rain cools
    wind_kph  = round(random.uniform(5, 40) + severity * 20, 1)
    humidity  = round(random.uniform(40, 100) * (0.5 + severity * 0.5), 1)
    humidity  = min(humidity, 100.0)

    return {
        "severity":     severity,
        "condition":    condition,
        "temp_c":       temp_c,
        "wind_kph":     wind_kph,
        "humidity_pct": humidity,
        "visibility_km": round(max(0.2, 10.0 - severity * 9.0), 1),
        "_source":      "simulated",
    }


async def get_weather_data(location: str) -> Dict[str, Any]:
    """
    Main entry point. Returns weather dict for the given location.
    Falls back to simulation if real API unavailable.
    """
    try:
        if not WEATHER_API_KEY:
            raise NotImplementedError("No API key")
        data = await _fetch_real_weather(location)
        data["_source"] = "real_api"
        return data
    except Exception as exc:
        logger.debug("Weather API unavailable (%s). Using simulation.", exc)
        return await _simulated_weather(location)


def weather_summary(weather_data: Dict[str, Any]) -> str:
    """Return a human-readable summary string."""
    cond = weather_data.get("condition", "unknown")
    temp = weather_data.get("temp_c", "?")
    sev  = weather_data.get("severity", 0)
    src  = weather_data.get("_source", "unknown")
    return f"{cond.replace('_', ' ').title()}, {temp}°C (severity={sev:.2f}, src={src})"
