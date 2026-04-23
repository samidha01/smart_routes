import { useState, useEffect, useRef } from 'react'

// Haversine distance in meters
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const p1 = lat1 * Math.PI/180;
  const p2 = lat2 * Math.PI/180;
  const dp = (lat2-lat1) * Math.PI/180;
  const dl = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dp/2) * Math.sin(dp/2) +
            Math.cos(p1) * Math.cos(p2) *
            Math.sin(dl/2) * Math.sin(dl/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Bearing from point 1 to point 2
function getBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI/180;
  const p2 = lat2 * Math.PI/180;
  const dl = (lon2-lon1) * Math.PI/180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  const theta = Math.atan2(y, x);
  return (theta*180/Math.PI + 360) % 360;
}

export function useGeolocation(isNavigating, activeRoute) {
  const [location, setLocation] = useState(null)
  const [error, setError] = useState(null)
  const simRef = useRef({ active: false, index: 0, progress: 0 })
  const watchIdRef = useRef(null)

  useEffect(() => {
    if (!isNavigating) {
      if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current)
      simRef.current.active = false
      setLocation(null)
      return
    }

    let realGpsActive = false;
    
    // Try real GPS
    if ('geolocation' in navigator) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          realGpsActive = true;
          simRef.current.active = false;
          setLocation({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            heading: pos.coords.heading || 0,
            speed: pos.coords.speed || 0,
            isSimulated: false
          });
        },
        (err) => {
          console.warn("Real GPS failed, falling back to simulation.", err);
          startSimulation();
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
      );
    } else {
      startSimulation();
    }

    // Fallback: If no real GPS updates after 3 seconds, start simulation
    const timeout = setTimeout(() => {
      if (!realGpsActive) startSimulation();
    }, 3000);

    return () => {
      clearTimeout(timeout);
      if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current);
      simRef.current.active = false;
    };
  }, [isNavigating])

  function startSimulation() {
    if (simRef.current.active) return;
    if (!activeRoute || !activeRoute.path_geometry) return;
    
    simRef.current.active = true;
    simRef.current.index = 0;
    simRef.current.progress = 0;
    
    let lastTime = performance.now();
    
    function tick(now) {
      if (!simRef.current.active) return;
      
      const dt = (now - lastTime) / 1000; // seconds
      lastTime = now;
      
      const geom = activeRoute.path_geometry;
      let i = simRef.current.index;
      
      if (i >= geom.length - 1) {
        simRef.current.active = false; // Reached destination
        return; 
      }
      
      const p1 = geom[i];
      const p2 = geom[i+1];
      
      // Get traffic density for this segment if available
      let density = 0.5; // default moderate
      if (activeRoute.segments) {
         // Find which segment this point belongs to (approximation by index ratio)
         const ratio = i / geom.length;
         const segIndex = Math.floor(ratio * activeRoute.segments.length);
         if (activeRoute.segments[segIndex]) {
             density = activeRoute.segments[segIndex].density;
         }
      }
      
      // Speed based on traffic: Green (15m/s), Yellow (8m/s), Red (3m/s)
      let speed_mps = 15;
      if (density > 0.70) speed_mps = 3;
      else if (density > 0.40) speed_mps = 8;
      
      const dist = getDistance(p1[1], p1[0], p2[1], p2[0]); // lat, lon
      if (dist === 0) {
        simRef.current.index++;
      } else {
        // Move progress
        simRef.current.progress += (speed_mps * dt) / dist;
        if (simRef.current.progress >= 1) {
          simRef.current.index++;
          simRef.current.progress = 0;
        }
      }
      
      const p = simRef.current.progress;
      const currentLat = p1[1] + (p2[1] - p1[1]) * p;
      const currentLon = p1[0] + (p2[0] - p1[0]) * p;
      const heading = getBearing(p1[1], p1[0], p2[1], p2[0]);
      
      setLocation({
        latitude: currentLat,
        longitude: currentLon,
        heading: heading,
        speed: speed_mps,
        isSimulated: true
      });
      
      requestAnimationFrame(tick);
    }
    
    requestAnimationFrame(tick);
  }

  // Restart simulation if route changes and we are simulating
  useEffect(() => {
    if (isNavigating && simRef.current.active && activeRoute) {
       simRef.current.active = false;
       setTimeout(startSimulation, 100);
    }
  }, [activeRoute])

  return { location, error }
}
