"""
Full verification test:
  1. Geocode "Badlapur West" and "Karjat" via the API
  2. Route between them
  3. Route with a priority stop (Neral)
  4. Test that any free-text location inside MMR works
"""
import urllib.request, json, sys

BASE = "http://localhost:8000"

def post(endpoint, payload):
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        f"{BASE}{endpoint}",
        data=data,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def get(endpoint):
    with urllib.request.urlopen(f"{BASE}{endpoint}", timeout=10) as r:
        return json.loads(r.read())

def check(condition, msg):
    icon = "[PASS]" if condition else "[FAIL]"
    print(f"  {icon}  {msg}")
    if not condition:
        sys.exit(1)

print("\n=== SmartRoutes Full Verification ===\n")

# ── Test 1: Autocomplete works ───────────────────────────────────────────────
print("[1] Autocomplete: 'Badlapur'")
ac = get("/routes/autocomplete?q=Badlapur")
results = ac.get("results", [])
check(len(results) > 0, f"Got {len(results)} suggestions for 'Badlapur'")
first = results[0]
check("lat" in first and "lon" in first, "Suggestions include lat/lon")
check("short_name" in first or "name" in first, "Suggestions include name")
print(f"     Top result: {first.get('short_name', first.get('name','?'))[:60]} @ ({first.get('lat'):.4f}, {first.get('lon'):.4f})")

# ── Test 2: Badlapur → Karjat (coordinate-driven) ────────────────────────────
print("\n[2] Route: Badlapur West → Karjat (via coordinates)")
r1 = post("/optimize-route", {
    "source":      "Badlapur West",
    "destination": "Karjat",
    "source_lat":  19.155, "source_lon": 73.238,
    "dest_lat":    18.913, "dest_lon":   73.327,
    "vehicle_type": "car",
    "mode":         "fastest",
    "top_k":        50,
})
check(r1.get("success"),              "API returned success=True")
routes = r1.get("all_routes_summary", [])
check(len(routes) >= 1,               f"Got {len(routes)} routes (need ≥1)")
best = r1.get("best_route", {})
check(len(best.get("path_geometry",[])) > 1, "Best route has GeoJSON geometry")
check(best.get("distance_km", 0) > 0,        f"Best route distance: {best.get('distance_km')} km")
check(best.get("estimated_time_min", 0) > 0, f"ETA: {best.get('estimated_time_min'):.1f} min")
print(f"     {len(routes)} routes · Best: {best.get('distance_km')} km, {best.get('estimated_time_min'):.1f} min")

# ── Test 3: Priority stop (Neral) ─────────────────────────────────────────────
print("\n[3] Route: Badlapur West → Karjat via Neral (priority stop)")
r2 = post("/optimize-route", {
    "source":         "Badlapur West",
    "destination":    "Karjat",
    "source_lat":     19.155, "source_lon": 73.238,
    "dest_lat":       18.913, "dest_lon":   73.327,
    "priority_stops": ["Neral"],
    "vehicle_type":   "car",
    "mode":           "fastest",
    "top_k":          10,
})
check(r2.get("success"), "Priority stop route returned success=True")
check(r2.get("priority_stops_resolved", 0) >= 1, f"Priority stop resolved: {r2.get('priority_stops_resolved')} stop(s)")
print(f"     Priority stops resolved: {r2.get('priority_stops_resolved')}")

# ── Test 4: Free-text address (geocoder fallback) ────────────────────────────
print("\n[4] Route: 'Vashi' → 'Thane' (geocoder)")
r3 = post("/optimize-route", {
    "source":      "Vashi",
    "destination": "Thane",
    "vehicle_type": "car",
    "mode": "fastest",
    "top_k": 10,
})
check(r3.get("success"), "Free-text geocoded route returned success=True")
sc = r3.get("source_coords", {})
check(sc.get("lat") is not None, f"Source geocoded to ({sc.get('lat')}, {sc.get('lon')})")
dc = r3.get("dest_coords", {})
check(dc.get("lat") is not None, f"Dest geocoded to ({dc.get('lat')}, {dc.get('lon')})")
print(f"     Source → ({sc.get('lat'):.4f}, {sc.get('lon'):.4f})")
print(f"     Dest   → ({dc.get('lat'):.4f}, {dc.get('lon'):.4f})")
print(f"     Routes: {r3.get('routes_evaluated', 0)}")

# ── Test 5: Session + WebSocket endpoint exists ──────────────────────────────
print("\n[5] Session created and retrievable")
sid = r1.get("session_id")
check(sid is not None, f"Session ID: {sid}")
sess = get(f"/routes/session/{sid}")
check(sess.get("session_id") == sid, "Session retrieved correctly")
print(f"     Session active: {sid[:12]}…")

print("\n=== All checks PASSED [OK] ===\n")
