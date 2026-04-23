import requests
import random
import time

def fetch_osrm_route(lon1, lat1, lon2, lat2):
    url = f"https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson&alternatives=true"
    resp = requests.get(url)
    return resp.json()

if __name__ == "__main__":
    res = fetch_osrm_route(72.8777, 19.0760, 72.9777, 19.1760)
    routes = res.get("routes", [])
    print(f"Num routes: {len(routes)}")
