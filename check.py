import urllib.request
import json
data = json.dumps({"source": "BWSL_South_Toll", "destination": "Thane", "vehicle_type": "car", "mode": "fastest"}).encode("utf-8")
req = urllib.request.Request("http://localhost:8000/routes/optimize", data=data, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req) as response:
    body = json.loads(response.read())
    segs = body["best_route"]["segments"]
    print(f"Num segments: {len(segs)}")
    if segs:
        print("First segment keys:", list(segs[0].keys()))
        print("First segment color:", segs[0]["color"])
        print("First segment path len:", len(segs[0]["path"]))
