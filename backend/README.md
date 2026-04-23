# Dynamic AI Routing Engine

A **production-ready, backend-only AI routing engine** built with FastAPI, NetworkX, scikit-learn and WebSockets.

---

## Project Structure

```
backend/
├── main.py                    # FastAPI entry point, lifespan management
├── routes/
│   └── optimize.py            # All REST + WebSocket endpoints
├── engine/
│   ├── graph_builder.py       # NetworkX DiGraph (80 nodes, 400+ edges)
│   ├── k_shortest.py          # Yen's K-Shortest Paths (top-50 routes)
│   ├── feature_engine.py      # 8-dimensional feature vector per route
│   ├── scoring.py             # Weighted multi-criteria scoring + normalization
│   ├── ml_model.py            # RandomForestRegressor (delivery cost prediction)
│   └── rerouting.py           # 30s background loop + WebSocket push updates
├── data/
│   └── vehicle_db.json        # 100+ vehicles (bikes/cars/trucks/tempos) with mileage
├── services/
│   ├── traffic_api.py         # Traffic data (real API / time-aware simulation)
│   └── weather_api.py         # Weather data (real API / monsoon-aware simulation)
├── requirements.txt
├── .env.example
└── test_engine.py             # Integration tests (no server needed)
```

---

## Quickstart

### 1. Install dependencies
```bash
cd backend
pip install -r requirements.txt
```

### 2. Run integration tests (no server required)
```bash
python test_engine.py
```

### 3. Start the server
```bash
python main.py
# or
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Interactive docs at **http://127.0.0.1:8000/docs**

---

## API Reference

### `POST /optimize-route`

Generate and rank 50 candidate routes with AI scoring.

**Request body:**
```json
{
  "source":         "Central_Station",
  "destination":    "Airport_Terminal",
  "vehicle_type":   "car",
  "vehicle_brand":  "Maruti Suzuki",
  "vehicle_model":  "Swift",
  "mileage":        23,
  "fuel_type":      "petrol",
  "priority_stops": ["Hebbal_Flyover"],
  "mode":           "fastest",
  "top_k":          50
}
```

**Response includes:**
- `best_route` – optimal route with full score breakdown
- `alternative_routes` – top 3 alternatives
- `savings` – time & fuel saved vs next-best route
- `all_routes_summary` – ranked list of all 50 routes
- `session_id` – use for WebSocket live re-routing

---

### `GET /routes/nodes`
List all 80 graph nodes with lat/lon/zone.

### `GET /routes/vehicles`
Full vehicle database (100+ entries).

### `GET /routes/vehicles/{vehicle_type}`
Filter by `bike`, `car`, `truck`, or `tempo`.

### `GET /routes/traffic-snapshot`
Current simulated traffic density for all nodes.

### `GET /routes/weather-snapshot`
Current simulated weather conditions.

### `GET /routes/model-metrics`
RandomForest model quality (MAE, R², feature importances).

### `GET /routes/session/{session_id}`
Get re-routing session status.

### `DELETE /routes/session/{session_id}`
Close a session.

---

### `WS /ws/reroute/{session_id}`

Real-time WebSocket – connect after `POST /optimize-route`.

Receives push updates **every 30 seconds** when a better route is discovered:

```json
{
  "event":           "reroute_update",
  "session_id":      "...",
  "improvement_pct": 8.4,
  "new_best_route":  { ... },
  "alternatives":    [ {...}, {...}, {...} ],
  "savings":         { "time_saved_min": 4.2, "fuel_saved": 0.21 }
}
```

Send `ping` → server replies `pong`. Send `close` → graceful disconnect.

---

## Scoring Formula

```
score = 0.30 × time_norm
      + 0.25 × traffic_norm
      + 0.20 × fuel_norm
      + 0.10 × weather_norm
      + 0.10 × road_penalty_norm
      + 0.05 × priority_deviation_norm
```

All features are **min-max normalised** across the candidate set before scoring.  
**Eco mode** shifts weight: fuel ↑ 0.45, time ↓ 0.15.

---

## Fuel Estimation

```
fuel = (distance_km / effective_mileage) × traffic_factor
effective_mileage = mileage / traffic_factor × (1 − weather_severity × 0.10)
# eco mode adds +10% mileage efficiency
```

Electric vehicles → kWh consumed (0.15 kWh/km base).

---

## Vehicle Database Coverage

| Type   | Brands                          | Models |
|--------|---------------------------------|--------|
| Bikes  | Hero, Honda, Bajaj, RE, TVS, Yamaha, Suzuki, Ola, Ather | 40+ |
| Cars   | Maruti, Hyundai, Tata, Kia, Toyota, Honda, Mahindra, Renault, VW, Skoda | 60+ |
| Trucks | Tata, Ashok Leyland, Mahindra, Eicher, BharatBenz | 20+ |
| Tempos | Tata, Mahindra, Piaggio, Force, Bajaj, TVS | 15+ |

---

## Graph Details

- **80 nodes** – named city locations (Central Station, Airport, IT hubs, junctions…)
- **400+ directed edges** – with `distance_km`, `base_time_min`, `road_type`, `lanes`, `quality_score`, `signals_count`
- **Road types**: expressway, highway, arterial, collector, local, service
- Strongly connected via proximity-based wiring + cross-zone bridges

---

## Environment Variables

Copy `.env.example` → `.env`:

| Variable         | Purpose                        |
|------------------|--------------------------------|
| `TRAFFIC_API_KEY`| HERE Maps traffic API key      |
| `WEATHER_API_KEY`| OpenWeatherMap API key         |
| `FORCE_RETRAIN`  | Force ML model re-training     |
| `HOST` / `PORT`  | Server bind address            |

Without API keys the engine **automatically falls back to realistic simulation**.
