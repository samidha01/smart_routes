import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import Map from 'react-map-gl/maplibre'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import DeckGL from '@deck.gl/react'
import { PathLayer, ScatterplotLayer, ColumnLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import NavigationHUD from './NavigationHUD'
import './MapView.css'

// ── Map styles ───────────────────────────────────────────────────────────────
const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'


// Satellite + CartoDB dark labels overlay (hybrid)
const HYBRID_STYLE = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: '© Esri, Maxar, Earthstar Geographics',
      maxzoom: 19,
    },
    labels: {
      type: 'raster',
      tiles: [
        'https://cartodb-basemaps-a.global.ssl.fastly.net/dark_only_labels/{z}/{x}/{y}.png',
        'https://cartodb-basemaps-b.global.ssl.fastly.net/dark_only_labels/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 18,
    },
  },
  layers: [
    { id: 'satellite-layer', type: 'raster', source: 'satellite', minzoom: 0, maxzoom: 22 },
    { id: 'labels-layer',    type: 'raster', source: 'labels',    minzoom: 0, maxzoom: 22, paint: { 'raster-opacity': 0.9 } },
  ],
}

const MAP_STYLES = {
  dark:   { style: DARK_STYLE,   label: 'Dark',   icon: 'dark_mode' },
  hybrid: { style: HYBRID_STYLE, label: 'Hybrid', icon: 'layers' },
}

const INITIAL_VIEW_STATE = {
  longitude: 72.9781,
  latitude:  19.1183,
  zoom:      11,
  pitch:     60,
  bearing:   -15,
}

// Route colour palette
const TOP4_COLORS = [
  [34,  212, 114],   // rank 1 – neon green
  [74,  158, 245],   // rank 2 – bright cyan-blue
  [247, 182,  54],   // rank 3 – amber
  [200, 100, 245],   // rank 4 – violet
]
const BG_COLOR = [100, 130, 160]

// Traffic colour bands (applied per-segment when a route is selected)
const TRAFFIC_COLORS = {
  green:  [34,  212, 114, 220],  // free flow
  yellow: [245, 166,  35, 220],  // moderate
  red:    [255,  79, 109, 220],  // congested
}

// ── Utility ───────────────────────────────────────────────────────────────────

function getBounds(path) {
  if (!path || path.length === 0) return null
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lng, lat] of path) {
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  if (!isFinite(minLng)) return null
  return { minLng, maxLng, minLat, maxLat }
}

function boundsToViewState(bounds, currentPitch = 60) {
  if (!bounds) return null
  const centerLng = (bounds.minLng + bounds.maxLng) / 2
  const centerLat = (bounds.minLat + bounds.maxLat) / 2
  const lngSpan   = bounds.maxLng - bounds.minLng
  const latSpan   = bounds.maxLat - bounds.minLat
  const span      = Math.max(lngSpan, latSpan, 0.005)
  const zoom      = Math.max(8, Math.min(15, Math.log2(0.8 / span) + 9))
  return {
    longitude: centerLng, latitude: centerLat,
    zoom, pitch: currentPitch, bearing: -15,
    transitionDuration: 900,
  }
}

/**
 * Build per-route path data with a progress fraction [0..1].
 */
function buildAnimatedPath(path, progress) {
  if (!path || path.length < 2) return path || []
  const total = path.length - 1
  const idx   = Math.floor(progress * total)
  const frac  = (progress * total) - idx
  const partial = path.slice(0, idx + 1)
  if (idx < total && frac > 0) {
    const [x0, y0] = path[idx]
    const [x1, y1] = path[idx + 1]
    partial.push([x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac])
  }
  return partial
}

// Build timestamp-stamped waypoints for TripsLayer from a path
function buildTripWaypoints(path) {
  if (!path || path.length < 2) return []
  return path.map((pt, i) => ({
    coordinates: pt,
    timestamp: i / (path.length - 1),  // 0..1
  }))
}

/**
 * Split a path into segments coloured by simulated traffic.
 * Uses time-of-day + deterministic per-segment variation to look realistic.
 * Returns [{ path: [[lng,lat],[lng,lat]], color: [r,g,b,a] }, ...]
 */
function buildTrafficSegments(path) {
  if (!path || path.length < 2) return []
  const hour = new Date().getHours()
  const isPeak = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20)
  const segments = []

  // Group consecutive points with same traffic color into one segment
  let segPath = [path[0]]
  let prevColor = null

  for (let i = 0; i < path.length - 1; i++) {
    // Deterministic but varied: seed from index + hour
    const seed = ((i * 2654435761 + hour * 1000003) >>> 0) % 100
    const density = isPeak ? Math.min(99, seed * 1.4) : seed * 0.8

    let color
    if (density > 68) color = TRAFFIC_COLORS.red
    else if (density > 38) color = TRAFFIC_COLORS.yellow
    else color = TRAFFIC_COLORS.green

    const colorKey = color.join(',')

    if (prevColor && colorKey !== prevColor) {
      // Flush current segment
      segments.push({ path: [...segPath, path[i]], color: prevColor.split(',').map(Number) })
      segPath = [path[i]]
    }

    segPath.push(path[i + 1])
    prevColor = colorKey
  }

  if (segPath.length >= 2 && prevColor) {
    segments.push({ path: segPath, color: prevColor.split(',').map(Number) })
  }

  return segments
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapView({
  result,
  selectedRank,
  onSelectRoute,
  rerouteEvent,
  isNavigating,
  onEndNavigation,
  userLocation,
  fuelStations = [],
  fuelCritical = false,
}) {
  const hasData = result && result.best_route

  const [viewState,  setViewState]  = useState(INITIAL_VIEW_STATE)
  const [hoverInfo,  setHoverInfo]  = useState(null)
  const [is3D,       setIs3D]       = useState(true)
  const [mapStyleKey, setMapStyleKey] = useState('dark')  // dark | satellite | hybrid

  // Trip animation time [0..1] looping
  const [tripTime, setTripTime] = useState(0)
  const tripRafRef = useRef(null)
  const tripStartRef = useRef(null)
  const TRIP_LOOP_DURATION = 2800 // ms for one full sweep

  // Route draw animation
  const [animProgress, setAnimProgress] = useState({})
  const animRef    = useRef({})
  const rafRef     = useRef(null)
  const prevResultRef   = useRef(null)
  const prevSelectedRef = useRef(null)

  // ── Trips animation loop ──────────────────────────────────────────────────
  useEffect(() => {
    if (!hasData) return

    const tick = (ts) => {
      if (!tripStartRef.current) tripStartRef.current = ts
      const elapsed = (ts - tripStartRef.current) % TRIP_LOOP_DURATION
      setTripTime(elapsed / TRIP_LOOP_DURATION)
      tripRafRef.current = requestAnimationFrame(tick)
    }
    tripRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (tripRafRef.current) cancelAnimationFrame(tripRafRef.current)
      tripStartRef.current = null
    }
  }, [hasData])
  const { allRoutes, bgRoutes, top4Routes, endpoints } = useMemo(() => {
    if (!hasData) return { allRoutes: [], bgRoutes: [], top4Routes: [], endpoints: [] }

    const all = []
    all.push({ rank: 1, ...result.best_route })
    ;(result.alternative_routes || []).forEach((r, i) => all.push({ rank: i + 2, ...r }))
    ;(result.all_routes_summary || []).forEach(r => {
      if (!all.find(a => a.rank === r.rank)) all.push({ ...r })
    })

    all.forEach(r => {
      const raw = (r.path_geometry?.length > 0) ? r.path_geometry
                : (r.path?.length > 0)          ? r.path
                : (r.geometry?.coordinates?.length > 0) ? r.geometry.coordinates
                : []
      r._path = raw.filter(pt => Array.isArray(pt) && pt.length >= 2
        && isFinite(pt[0]) && isFinite(pt[1]))
    })

    const bg  = all.filter(r => r.rank > 4)
    const top = all.filter(r => r.rank <= 4).sort((a, b) => a.rank - b.rank)

    const pts = []
    const best = all.find(r => r.rank === 1)
    if (best?._path.length > 0) {
      pts.push({ coords: best._path[0],                   type: 'origin', name: result.source })
      pts.push({ coords: best._path[best._path.length-1], type: 'dest',   name: result.destination })
    } else {
      const sc = result.source_coords
      const dc = result.dest_coords
      if (sc?.lat != null) pts.push({ coords: [sc.lon, sc.lat], type: 'origin', name: result.source })
      if (dc?.lat != null) pts.push({ coords: [dc.lon, dc.lat], type: 'dest',   name: result.destination })
    }

    return { allRoutes: all, bgRoutes: bg, top4Routes: top, endpoints: pts }
  }, [hasData, result])

  // Memoised traffic segments for selected route (expensive, cache it)
  const trafficSegments = useMemo(() => {
    const route = allRoutes.find(r => r.rank === selectedRank)
    return buildTrafficSegments(route?._path || [])
  }, [allRoutes, selectedRank])

  // Selected route object for NavigationHUD
  const selectedRoute = useMemo(
    () => allRoutes.find(r => r.rank === selectedRank),
    [allRoutes, selectedRank]
  )

  // ── One-time draw animation ────────────────────────────────────────────────
  useEffect(() => {
    setAnimProgress({})
    animRef.current = {}
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (!hasData || top4Routes.length === 0) return

    const ANIM_DURATION = 1400
    const STAGGER       = 120
    const now = performance.now()
    top4Routes.forEach((r, i) => {
      animRef.current[r.rank] = { startTs: now + i * STAGGER, duration: DURATION, done: false }
    })

    let allDone = false
    const tick = (ts) => {
      if (allDone) return
      const next = {}
      let anyRunning = false
      for (const [rankStr, info] of Object.entries(animRef.current)) {
        const rank = Number(rankStr)
        if (info.done) { next[rank] = 1.0; continue }
        const elapsed = ts - info.startTs
        if (elapsed < 0) { next[rank] = 0; anyRunning = true; continue }
        const p = Math.min(1, elapsed / info.duration)
        next[rank] = p
        if (p < 1) anyRunning = true
        else info.done = true
      }
      setAnimProgress(next)
      if (anyRunning) rafRef.current = requestAnimationFrame(tick)
      else { allDone = true; rafRef.current = null }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [result]) // eslint-disable-line

  // ── Camera: fit all routes when result arrives ─────────────────────────────
  useEffect(() => {
    if (!hasData || isNavigating) return
    const bestPath = result.best_route?.path_geometry || result.best_route?.path || result.best_route?.geometry?.coordinates
    const bounds = getBounds(bestPath)
    if (bounds) {
      const vs = boundsToViewState(bounds, viewState.pitch)
      if (vs) setViewState(vs)
    } else {
  }, [result]) // eslint-disable-line react-hooks/exhaustive-deps
      if (sc?.lat != null && dc?.lat != null) {
        const midLat = (sc.lat + dc.lat) / 2
        const midLon = (sc.lon + dc.lon) / 2
        const span   = Math.max(Math.abs(dc.lat - sc.lat), Math.abs(dc.lon - sc.lon), 0.01)
        const zoom   = Math.max(8, Math.min(14, Math.log2(0.8 / span) + 9))
        setViewState(v => ({ ...v, latitude: midLat, longitude: midLon, zoom, transitionDuration: 900 }))
      }
    }
  }, [result]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera: fit selected route on card click ───────────────────────────────
  useEffect(() => {
    if (prevSelectedRef.current === selectedRank && prevResultRef.current === result) return
    prevSelectedRef.current = selectedRank
    prevResultRef.current   = result
    if (!hasData || isNavigating) return
    const route = allRoutes.find(r => r.rank === selectedRank)
    const path  = route?._path
    if (!path?.length) return
    const bounds = getBounds(path)
    const vs = boundsToViewState(bounds, viewState.pitch)
    if (vs) setViewState(vs)
  }, [selectedRank, hasData, result]) // eslint-disable-line

  // ── Camera: GPS tracking during navigation ─────────────────────────────────
  useEffect(() => {
    if (!isNavigating || !userLocation || userLocation.isSimulated) return
    setViewState(v => ({
      ...v,
      longitude: userLocation.longitude, latitude: userLocation.latitude,
      zoom: 17, pitch: 65, bearing: userLocation.heading || 0,
      transitionDuration: 150,
    }))
  }, [isNavigating, userLocation])

  // ── 2D / 3D toggle ────────────────────────────────────────────────────────
  function toggle3D() {
    setIs3D(prev => {
      const next = !prev
      setViewState(v => ({
        ...v,
        pitch:   next ? 60 : 0,
        bearing: next ? -15 : 0,
        transitionDuration: 700,
      }))
      return next
    })
  }

  // ── Build Deck.gl layers ───────────────────────────────────────────────────
  const layers = useMemo(() => {
    const lys = []

    // ── LAYER 1: Background routes ───────────────────────────────────────────
    if (bgRoutes.length > 0) {
      lys.push(new PathLayer({
        id:             'bg-routes',
        data:           bgRoutes,
        pickable:       !isNavigating,
        widthMinPixels: 1.5, widthMaxPixels: 2.5,
        getPath:        d => d._path,
        getColor:       d => {
          const sel = d.rank === selectedRank
          if (isNavigating) return [...BG_COLOR, 10]
          return sel ? [...BG_COLOR, 200] : [...BG_COLOR, 35]
        },
        getWidth:       d => d.rank === selectedRank ? 2 : 1,
        onHover:        info => !isNavigating && setHoverInfo(info),
        onClick:        info => { if (!isNavigating && info.object) onSelectRoute(info.object.rank) },
        parameters:     { depthTest: false },
        updateTriggers: { getColor: [selectedRank, isNavigating], getWidth: [selectedRank] },
      }))
    }

    // ── LAYER 2: Top 4 routes with animation ────────────────────────────────
    if (top4Routes.length > 0) {
      const animatedData = top4Routes.map(r => {
        const progress = animProgress[r.rank] ?? 0
        const drawnPath = progress >= 1 ? r._path : buildAnimatedPath(r._path, progress)
        return { ...r, _drawnPath: drawnPath }
      })
      lys.push(new PathLayer({
        id:             'top4-routes',
        data:           animatedData,
        pickable:       !isNavigating,
        widthMinPixels: 3, widthMaxPixels: 5,
        capRounded: true, jointRounded: false,
        getPath:        d => d._drawnPath,
        getColor:       d => {
          if (isNavigating) return [...BG_COLOR, 20]
          const col   = TOP4_COLORS[(d.rank - 1) % TOP4_COLORS.length]
          const isSel = selectedRank == null || d.rank === selectedRank
          return [...col, isSel ? 255 : 100]
        },
        getWidth: d => {
          const base = d.rank === 1 ? 5 : d.rank <= 2 ? 4 : 3
          return d.rank === selectedRank ? base + 1 : base
        },
        onHover:        info => !isNavigating && setHoverInfo(info),
        onClick:        info => { if (!isNavigating && info.object) onSelectRoute(info.object.rank) },
        parameters:     { depthTest: false },
        updateTriggers: {
          getPath:  [JSON.stringify(animProgress)],
          getColor: [selectedRank, isNavigating, JSON.stringify(animProgress)],
          getWidth: [selectedRank],
        },
      }))
    }

    // ── LAYER 3: TripsLayer – animated neon light trail on top 4 routes ──────
    if (top4Routes.length > 0 && !isNavigating) {
      const tripsData = top4Routes
        .filter(r => (animProgress[r.rank] ?? 0) >= 0.5)  // only show after route is drawn
        .map(r => ({
          ...r,
          waypoints: buildTripWaypoints(r._path),
        }))
        .filter(r => r.waypoints.length >= 2)

      if (tripsData.length > 0) {
        lys.push(new TripsLayer({
          id:            'trips-glow',
          data:          tripsData,
          getPath:       d => d.waypoints.map(w => w.coordinates),
          getTimestamps: d => d.waypoints.map(w => w.timestamp),
          getColor:      d => {
            const col = TOP4_COLORS[(d.rank - 1) % TOP4_COLORS.length]
            const isSel = selectedRank == null || d.rank === selectedRank
            return [...col, isSel ? 255 : 160]
          },
          currentTime:   tripTime,
          trailLength:   0.18,
          widthMinPixels: d => d.rank === 1 ? 6 : 4,
          widthMaxPixels: d => d.rank === 1 ? 10 : 7,
          capRounded:    true,
          parameters:    { depthTest: false },
          updateTriggers: {
            getColor: [selectedRank],
          },
        }))
      }
    }

    // ── LAYER 4: Navigation traffic path ────────────────────────────────────
    if (trafficSegments.length > 0) {
      lys.push(new PathLayer({
        id:             'traffic-segments',
        data:           trafficSegments,
        getPath:        d => d.path,
        getColor:       d => d.color,
        widthMinPixels: 3, widthMaxPixels: 6,
        capRounded:     true,
        jointRounded:   false,
        parameters:     { depthTest: false },
        updateTriggers: { getWidth: [isNavigating] },
      }))
    }

    // LAYER 4: GPS user marker (blue dot)
    if (userLocation && (isNavigating || !userLocation.isSimulated)) {
      lys.push(new ScatterplotLayer({
        id: 'user-marker-glow',
        data: [userLocation],
        getPosition:  d => [d.longitude, d.latitude],
        getFillColor: isNavigating ? [74, 158, 245, 45] : [34, 212, 114, 35],
        getRadius:    28, radiusUnits: 'pixels',
        parameters:   { depthTest: false },
      }))
      lys.push(new ScatterplotLayer({
        id: 'user-marker-ring',
        data: [userLocation],
        getPosition:    d => [d.longitude, d.latitude],
        getFillColor:   [255, 255, 255, 255],
        getRadius:      16, radiusUnits: 'pixels',
        parameters:     { depthTest: false },
      }))
    // ── LAYER 5: GPS user marker ─────────────────────────────────────────────
    if (userLocation && (isNavigating || !userLocation.isSimulated)) {
      lys.push(new ScatterplotLayer({
        id: 'user-marker',
        data: [userLocation],
        getPosition:  d => [d.longitude, d.latitude],
        getFillColor: isNavigating ? [74, 158, 245, 255] : [34, 212, 114, 255],
        getRadius:    11, radiusUnits: 'pixels',
        parameters:   { depthTest: false },
      }))
    }

    // ── LAYER 6: 3D Column towers at endpoints ───────────────────────────────
    if (!isNavigating && endpoints.length > 0) {
      lys.push(new ScatterplotLayer({
        id:           'endpoint-glow',
        data:         endpoints,
        getPosition:  d => d.coords,
        getFillColor: d => d.type === 'origin'
          ? [34, 212, 114, 40]
          : [255, 79, 109, 40],
        getRadius:    40, radiusUnits: 'pixels',
        parameters:   { depthTest: false },
      }))

      // 3D extruded column towers
      lys.push(new ColumnLayer({
        id:              'endpoint-towers',
        data:            endpoints,
        diskResolution:  32,
        radius:          35,
        extruded:        true,
        pickable:        true,
        getPosition:     d => d.coords,
        getFillColor:    d => d.type === 'origin'
          ? [34, 212, 114, 220]
          : [255, 79, 109, 220],
        getLineColor:    [255, 255, 255, 80],
        getElevation:    d => d.type === 'origin' ? 120 : 100,
        lineWidthMinPixels: 1,
        stroked:         true,
        onHover:         info => setHoverInfo(info),
        updateTriggers:  {},
      }))

      // Dot cap on top of each tower
      lys.push(new ScatterplotLayer({
        id:               'endpoint-dots',
        data:             endpoints,
        getPosition:      d => d.coords,
        getFillColor:     d => d.type === 'origin' ? [34,212,114,255] : [255,79,109,255],
        getLineColor:     [255, 255, 255],
        lineWidthMinPixels: 2,
        stroked:          true,
        radiusMinPixels:  7, radiusMaxPixels: 13,
        pickable:         true,
        onHover:          info => setHoverInfo(info),
        parameters:       { depthTest: false },
      }))
    }

    // ── LAYER 7: Fuel stations ─────────────────────────────────────────────
    if (fuelStations.length > 0) {
      lys.push(new ScatterplotLayer({
        id: 'fuel-stations-glow',
        data: fuelStations,
        getPosition:  d => [d.lon, d.lat],
        getFillColor: [245, 166, 35, 45],
        getRadius:    24, radiusUnits: 'pixels',
        parameters:   { depthTest: false },
      }))
      lys.push(new ScatterplotLayer({
        id: 'fuel-stations',
        data: fuelStations,
        getPosition:        d => [d.lon, d.lat],
        getFillColor:       [245, 166, 35, 255],
        getLineColor:       [255, 255, 255],
        stroked:            true,
        lineWidthMinPixels: 2,
        getRadius:          10, radiusUnits: 'pixels',
        pickable:           true,
        onHover:            info => setHoverInfo(info),
        parameters:         { depthTest: false },
      }))

      if (fuelCritical) {
        const activePath = allRoutes.find(r => r.rank === selectedRank)?._path || []
        if (activePath.length > 0) {
          const midPt = activePath[Math.floor(activePath.length / 2)]
          let nearest = null, minD = Infinity
          fuelStations.forEach(st => {
            const d = (st.lon - midPt[0]) ** 2 + (st.lat - midPt[1]) ** 2
            if (d < minD) { minD = d; nearest = st }
          })
          if (nearest) {
            lys.push(new PathLayer({
              id: 'fuel-route',
              data: [{ path: [midPt, [nearest.lon, nearest.lat]] }],
              getPath:        d => d.path,
              getColor:       [245, 166, 35, 200],
              getWidth:       3, widthMinPixels: 2, widthMaxPixels: 5,
              getDashArray:   [6, 4], dashJustified: true, capRounded: true,
              parameters:     { depthTest: false },
            }))
          }
        }
      }
    }

    return lys
  }, [bgRoutes, top4Routes, trafficSegments, animProgress, selectedRank, isNavigating,
      userLocation, endpoints, allRoutes, onSelectRoute, fuelStations, fuelCritical, tripTime])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="map-view" onContextMenu={e => e.preventDefault()}>
      <DeckGL
        layers={layers}
        viewState={viewState}
        onViewStateChange={e => setViewState(e.viewState)}
        controller={true}
        getCursor={({ isHovering }) => isHovering ? 'pointer' : 'grab'}
      >
        <Map reuseMaps mapStyle={MAP_STYLES[mapStyleKey].style} mapLib={maplibregl} />


        {hoverInfo?.object && !isNavigating && (
          <div className="deck-tooltip" style={{ left: hoverInfo.x + 12, top: hoverInfo.y + 12 }}>
            {hoverInfo.layer?.id === 'endpoints' || hoverInfo.layer?.id === 'endpoint-towers' || hoverInfo.layer?.id === 'endpoint-dots' ? (
              <strong>{hoverInfo.object.name?.replace(/_/g, ' ')}</strong>
            ) : hoverInfo.layer?.id === 'fuel-stations' ? (
              <>
                <strong>⛽ {hoverInfo.object.name}</strong>
                {hoverInfo.object.brand && <p>{hoverInfo.object.brand}</p>}
                <p style={{ color: '#f5a623' }}>Fuel Station</p>
              </>
            ) : (
              <>
                <strong>Rank #{hoverInfo.object.rank}</strong>
                {hoverInfo.object.estimated_time_min != null &&
                  <p>⏱ {Math.round(hoverInfo.object.estimated_time_min)} min</p>}
                {hoverInfo.object.distance_km != null &&
                  <p>📍 {hoverInfo.object.distance_km?.toFixed(1)} km</p>}
                {hoverInfo.object.composite_score != null &&
                  <p>Score: {((1 - hoverInfo.object.composite_score) * 100).toFixed(0)}</p>}
              </>
            )}
          </div>
        )}
      </DeckGL>

      {isNavigating && selectedRoute && (
        <NavigationHUD
          route={selectedRoute}
          userLocation={userLocation}
          onEnd={onEndNavigation}
        />
      )}

      {/* ── Legend ── */}
      <div className="map-legend">
        <div className="map-legend-title">{isNavigating ? 'Live Navigation' : 'Routing Engine'}</div>
        {!isNavigating ? (
          <>
            <div className="legend-row"><span className="legend-line" style={{ background: '#22d472', height: 4 }} /><span>Best Route (#1)</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#4a9ef5', height: 3 }} /><span>Alt #2</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#f7b636', height: 3 }} /><span>Alt #3</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#c864f5', height: 3 }} /><span>Alt #4</span></div>
            {/* Traffic legend when a route is selected */}
            {selectedRank != null && trafficSegments.length > 0 && (
              <>
                <div className="legend-divider" />
                <div className="legend-label">Traffic</div>
                <div className="legend-row"><span className="legend-line" style={{ background: '#22d472', height: 4 }} /><span>Free flow</span></div>
                <div className="legend-row"><span className="legend-line" style={{ background: '#f5a623', height: 4 }} /><span>Moderate</span></div>
                <div className="legend-row"><span className="legend-line" style={{ background: '#ff4f6d', height: 4 }} /><span>Heavy</span></div>
              </>
            )}
            {bgRoutes.length > 0 && (
              <div className="legend-row"><span className="legend-line" style={{ background: '#6482a0', height: 1.5, opacity: 0.4 }} /><span>Background ({bgRoutes.length})</span></div>
            )}
            {fuelStations.length > 0 && (
              <div className="legend-row">
                <span style={{ width: 12, height: 12, background: '#f5a623', borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />
                <span style={{ color: '#f5a623' }}>⛽ {fuelStations.length} Fuel Stations</span>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="legend-row"><span className="legend-line" style={{ background: '#22d472', height: 4 }} /><span>Free flow</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#f5a623', height: 4 }} /><span>Moderate</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#ff4f6d', height: 4 }} /><span>Heavy traffic</span></div>
            {userLocation?.isSimulated && (
              <div className="legend-row">
                <span className="material-icons-round" style={{ fontSize: 16, color: '#f5a623' }}>warning</span>
                <span style={{ color: '#f5a623' }}>Simulating GPS</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Live badge ── */}
      <div className="map-live-badge">
        <span className="live-pulse" />
        <span>
          {isNavigating
            ? 'Live Traffic & GPS'
            : hasData
              ? `${result.routes_evaluated || allRoutes.length} paths · 3D WebGL`
              : 'AI Map Engine – 3D View'}
        </span>
      </div>

      {/* ── Re-route toast ── */}
      {rerouteEvent && (
        <div className="map-reroute-toast fade-in-up">
          <span className="material-icons-round">refresh</span>
          <div>
            <strong>Better Route Found!</strong>
            <p>Score: {rerouteEvent.old_score?.toFixed(3)} → {rerouteEvent.new_score?.toFixed(3)}</p>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {!hasData && (
        <div className="map-empty-overlay">
          <span className="material-icons-round">route</span>
          <p>Enter any location in Mumbai, Navi Mumbai, Thane, Badlapur, Karjat…</p>
          <p style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: 4 }}>Real-world roads · 50 routes · AI ranked · 3D map</p>
        </div>
      )}
    </div>
  )
}
