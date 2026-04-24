import urllib.request
import json

data = json.dumps({
    "source": "Badlapur West",
    "destination": "Karjat",
    "source_lat": 19.155,
    "source_lon": 73.238,
    "dest_lat": 18.913,
    "dest_lon": 73.327,
    "vehicle_type": "car",
    "mode": "fastest",
    "top_k": 4
}).encode("utf-8")

req = urllib.request.Request(
    "http://localhost:8000/optimize-route", 
    data=data, 
    headers={"Content-Type": "application/json"}
)

try:
    with urllib.request.urlopen(req) as response:
        body = json.loads(response.read())
        routes = body.get("all_routes_summary", [])
        print(f"Success! Generated {len(routes)} routes.")
        if routes:
            print("Best route distance:", routes[0].get("distance_km"))
            print("Best route time:", routes[0].get("estimated_time_min"))
except Exception as e:
    print(f"Error: {e}")
    if hasattr(e, 'read'):
        print(e.read().decode())
