import requests
import json

def test_routing_api():
    # The API endpoint for our routing engine
    url = "http://127.0.0.1:8000/optimize-route"
    
    # Input payload
    payload = {
        "source": "CSMT",      # Starting point
        "destination": "Borivali", # Destination
        "vehicle_type": "car",
        "vehicle_model": "Swift",
        "mode": "fastest",                # 'fastest' or 'eco'
        "top_k": 5                        # Adjust this to generate more or fewer routes
    }
    
    print("="*60)
    print(f"--> Sending Request to AI Routing Engine...")
    print(f"From: {payload['source']} --> To: {payload['destination']}")
    print(f"Vehicle: {payload['vehicle_model']} ({payload['vehicle_type']}) | Mode: {payload['mode']}")
    print("="*60)
    
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
        
        data = response.json()
        
        print("\n[SUCCESS] API Response Received (Computation time: {}s)\n".format(data.get('computation_time_s')))
        
        # Display best route
        best = data.get("best_route", {})
        print("BEST ROUTE:")
        print(f"   Path: {' -> '.join(best.get('path', []))}")
        print(f"   Distance     : {best.get('distance_km')} km")
        print(f"   Est. Time    : {best.get('estimated_time_min')} min")
        print(f"   Fuel Est.    : {best.get('fuel_estimate')} Liters")
        print(f"   Traffic Level: {best.get('traffic_density')}")
        print(f"   AI Score     : {best.get('composite_score')}\n")
        
        # Display alternative routes
        alts = data.get("alternative_routes", [])
        if alts:
            print("ALTERNATIVE ROUTES:")
            for i, alt in enumerate(alts[:3], 1):
                print(f"   [{i}] Score: {alt.get('composite_score')} | Time: {alt.get('estimated_time_min')} min | Path: {' -> '.join(alt.get('path', [])[:3])}...")
                
        print("\n" + "="*60)
                
    except requests.exceptions.ConnectionError:
        print("[ERROR] Could not connect to the API. Is 'python main.py' running?")
    except Exception as e:
        print(f"[ERROR] Exception during request: {e}")

if __name__ == "__main__":
    test_routing_api()
