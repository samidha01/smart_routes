import { useState, useEffect, useMemo, useRef } from 'react'
import Map from 'react-map-gl/maplibre'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import DeckGL from '@deck.gl/react'
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import './MapView.css'

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const INITIAL_VIEW_STATE = {
  longitude: 72.9781,
  latitude:  19.1183,
  zoom:      10,
  pitch:     45,
  bearing:   0,
}

// Route colour palette
const TOP4_COLORS = [
  [34,  212, 114],   // rank 1 – neon green
  [74,  158, 245],   // rank 2 – bright cyan-blue
  [247, 182,  54],   // rank 3 – amber
  [200, 100, 245],   // rank 4 – violet
]
const BG_COLOR = [100, 130, 160]  // muted blue-grey for background routes

// ── Utility ──────────────────────────────────────────────────────────────────

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

function boundsToViewState(bounds, currentPitch = 45) {
  if (!bounds) return null
  const centerLng = (bounds.minLng + bounds.maxLng) / 2
  const centerLat = (bounds.minLat + bounds.maxLat) / 2
  const lngSpan   = bounds.maxLng - bounds.minLng
  const latSpan   = bounds.maxLat - bounds.minLat
  const span      = Math.max(lngSpan, latSpan, 0.005)
  const zoom      = Math.max(8, Math.min(15, Math.log2(0.8 / span) + 9))
  return {
    longitude: centerLng, latitude: centerLat,
    zoom, pitch: currentPitch, bearing: 0,
    transitionDuration: 800,
  }
}

/**
 * Build per-route path data with a progress fraction [0..1].
 * progress = 1.0 means fully drawn (animation complete).
 */
function buildAnimatedPath(path, progress) {
  if (!path || path.length < 2) return path || []
  const total = path.length - 1
  const idx   = Math.floor(progress * total)
  const frac  = (progress * total) - idx

  const partial = path.slice(0, idx + 1)
  // Interpolate the last point
  if (idx < total && frac > 0) {
    const [x0, y0] = path[idx]
    const [x1, y1] = path[idx + 1]
    partial.push([x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac])
  }
  return partial
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapView({
  result,
  selectedRank,
  onSelectRoute,
  rerouteEvent,
  isNavigating,
  userLocation,
}) {
  const hasData = result && result.best_route

  const [viewState,  setViewState]  = useState(INITIAL_VIEW_STATE)
  const [hoverInfo,  setHoverInfo]  = useState(null)

  // Animation: progress per top-4 route rank (0..1), stays at 1 when done
  const [animProgress, setAnimProgress] = useState({})
  const animRef    = useRef({})   // { rank: { startTs, duration } }
  const rafRef     = useRef(null)
  const prevResultRef   = useRef(null)
  const prevSelectedRef = useRef(null)

  // ── Build all route data from result ───────────────────────────────────────
  const { allRoutes, bgRoutes, top4Routes, endpoints } = useMemo(() => {
    if (!hasData) return { allRoutes: [], bgRoutes: [], top4Routes: [], endpoints: [] }

    const all = []
    all.push({ rank: 1, ...result.best_route })
    ;(result.alternative_routes || []).forEach((r, i) => all.push({ rank: i + 2, ...r }))
    ;(result.all_routes_summary || []).forEach(r => {
      if (!all.find(a => a.rank === r.rank)) all.push({ ...r })
    })

    // Normalise path — handle all OSRM geometry formats:
    //   path_geometry: [[lng, lat], ...]
    //   path:          [[lng, lat], ...]
    //   geometry.coordinates: [[lng, lat], ...]
    all.forEach(r => {
      const pg = r.path_geometry
      const p  = r.path
      const gc = r.geometry?.coordinates
      const raw = (pg && pg.length > 0) ? pg
                : (p  && p.length  > 0) ? p
                : (gc && gc.length > 0) ? gc
                : []
      // Filter out any degenerate points
      r._path = raw.filter(pt => Array.isArray(pt) && pt.length >= 2
        && isFinite(pt[0]) && isFinite(pt[1]))
    })

    const bg  = all.filter(r => r.rank > 4)
    const top = all.filter(r => r.rank <= 4).sort((a, b) => a.rank - b.rank)

    // Endpoints: prefer path geometry, fallback to source_coords/dest_coords from backend
    const pts = []
    const best = all.find(r => r.rank === 1)
    if (best && best._path.length > 0) {
      pts.push({ coords: best._path[0],                     type: 'origin', name: result.source })
      pts.push({ coords: best._path[best._path.length - 1], type: 'dest',   name: result.destination })
    } else {
      // GPS / coord fallback — backend always returns source_coords & dest_coords
      const sc = result.source_coords
      const dc = result.dest_coords
      if (sc?.lat != null) pts.push({ coords: [sc.lon, sc.lat], type: 'origin', name: result.source })
      if (dc?.lat != null) pts.push({ coords: [dc.lon, dc.lat], type: 'dest',   name: result.destination })
    }


    return { allRoutes: all, bgRoutes: bg, top4Routes: top, endpoints: pts }
  }, [hasData, result])

  // ── One-time animation for top 4 routes ────────────────────────────────────
  // Starts fresh whenever `result` changes. Animates each top-4 route
  // sequentially with a slight stagger, then STOPS (no loop).
  useEffect(() => {
    // Reset progress
    setAnimProgress({})
    animRef.current = {}
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    if (!hasData || top4Routes.length === 0) return

    const ANIM_DURATION = 1400   // ms per route draw
    const STAGGER       = 120    // ms between route starts

    const now = performance.now()
    top4Routes.forEach((r, i) => {
      animRef.current[r.rank] = {
        startTs:  now + i * STAGGER,
        duration: ANIM_DURATION,
        done:     false,
      }
    })

    let allDone = false
    const tick = (ts) => {
      if (allDone) return
      const next = {}
      let anyRunning = false
      for (const [rankStr, info] of Object.entries(animRef.current)) {
        const rank = Number(rankStr)
        if (info.done) {
          next[rank] = 1.0
          continue
        }
        const elapsed = ts - info.startTs
        if (elapsed < 0) {
          next[rank] = 0
          anyRunning = true
          continue
        }
        const p = Math.min(1, elapsed / info.duration)
        next[rank] = p
        if (p < 1) anyRunning = true
        else info.done = true
      }
      setAnimProgress(next)
      if (anyRunning) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        allDone = true
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [result]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera: fit all routes when result arrives ─────────────────────────────
  useEffect(() => {
    if (!hasData || isNavigating) return
    const bestPath = result.best_route?.path_geometry
                  || result.best_route?.path
                  || result.best_route?.geometry?.coordinates
    const bounds = getBounds(bestPath)
    if (bounds) {
      const vs = boundsToViewState(bounds, viewState.pitch)
      if (vs) setViewState(vs)
    } else {
      // GPS / coord fallback — backend returns source_coords & dest_coords objects
      const sc = result.source_coords
      const dc = result.dest_coords
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
    if (!hasData) return

    const route = allRoutes.find(r => r.rank === selectedRank)
    const path  = route?._path
    if (!path || path.length === 0) return
    const bounds = getBounds(path)
    const vs = boundsToViewState(bounds, viewState.pitch)
    if (vs) setViewState(vs)
  }, [selectedRank, hasData, result]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera: GPS tracking in navigation mode ────────────────────────────────
  useEffect(() => {
    if (!isNavigating || !userLocation || userLocation.isSimulated) return
    setViewState(v => ({
      ...v,
      longitude: userLocation.longitude, latitude: userLocation.latitude,
      zoom: 16, pitch: 60, bearing: userLocation.heading || 0,
      transitionDuration: 100,
    }))
  }, [isNavigating, userLocation])

  // ── Build Deck.gl layers ───────────────────────────────────────────────────
  const layers = useMemo(() => {
    const lys = []

    // ── LAYER 1: Background routes (drawn first, behind everything) ──────────
    if (bgRoutes.length > 0) {
      lys.push(new PathLayer({
        id:             'bg-routes',
        data:           bgRoutes,
        pickable:       !isNavigating,
        widthScale:     1,
        widthMinPixels: 1,
        widthMaxPixels: 2,
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

    // ── LAYER 2: Top 4 routes with one-time draw animation ──────────────────
    if (top4Routes.length > 0) {
      // Build animated path data — each route sliced to current progress
      const animatedData = top4Routes.map(r => {
        const progress = animProgress[r.rank] ?? 0
        const drawnPath = progress >= 1
          ? r._path
          : buildAnimatedPath(r._path, progress)
        return { ...r, _drawnPath: drawnPath }
      })

      lys.push(new PathLayer({
        id:             'top4-routes',
        data:           animatedData,
        pickable:       !isNavigating,
        widthScale:     1,
        widthMinPixels: 3,
        widthMaxPixels: 7,
        capRounded:     true,
        jointRounded:   true,
        getPath:        d => d._drawnPath,
        getColor:       d => {
          if (isNavigating) return [...BG_COLOR, 20]
          const col  = TOP4_COLORS[(d.rank - 1) % TOP4_COLORS.length]
          const isSel = selectedRank == null || d.rank === selectedRank
          return [...col, isSel ? 255 : 120]
        },
        getWidth:       d => {
          const base = d.rank === 1 ? 6 : d.rank <= 2 ? 5 : 4
          return d.rank === selectedRank ? base + 1 : base
        },
        onHover:        info => !isNavigating && setHoverInfo(info),
        onClick:        info => { if (!isNavigating && info.object) onSelectRoute(info.object.rank) },
        parameters:     { depthTest: false },
        // Re-render when animation progress changes or selection changes
        updateTriggers: {
          getPath:  [JSON.stringify(animProgress)],
          getColor: [selectedRank, isNavigating, JSON.stringify(animProgress)],
          getWidth: [selectedRank],
        },
      }))
    }

    // ── LAYER 3: Navigation traffic path ────────────────────────────────────
    const activeRoute = allRoutes.find(r => r.rank === selectedRank)
    if (isNavigating && activeRoute?.segments) {
      lys.push(new PathLayer({
        id:             'nav-traffic',
        data:           activeRoute.segments,
        getPath:        d => d.path,
        getColor:       d => d.color,
        getWidth:       8,
        widthMinPixels: 6,
        widthMaxPixels: 12,
        capRounded:     true,
        jointRounded:   true,
        parameters:     { depthTest: false },
      }))
    }

    // ── LAYER 4: GPS user marker ─────────────────────────────────────────────
    if (isNavigating && userLocation) {
      lys.push(new ScatterplotLayer({
        id:           'user-marker-bg',
        data:         [userLocation],
        getPosition:  d => [d.longitude, d.latitude],
        getFillColor: [255, 255, 255, 255],
        getRadius:    18, radiusUnits: 'pixels',
        parameters:   { depthTest: false },
      }))
      lys.push(new ScatterplotLayer({
        id:           'user-marker',
        data:         [userLocation],
        getPosition:  d => [d.longitude, d.latitude],
        getFillColor: [74, 158, 245, 255],
        getRadius:    12, radiusUnits: 'pixels',
        parameters:   { depthTest: false },
      }))
    }

    // ── LAYER 5: Source / destination endpoints ──────────────────────────────
    if (!isNavigating && endpoints.length > 0) {
      lys.push(new ScatterplotLayer({
        id:               'endpoints',
        data:             endpoints,
        getPosition:      d => d.coords,
        getFillColor:     d => d.type === 'origin' ? [34,212,114,255] : [255,79,109,255],
        getLineColor:     [255, 255, 255],
        lineWidthMinPixels: 2,
        stroked:          true,
        radiusMinPixels:  7,
        radiusMaxPixels:  13,
        pickable:         true,
        onHover:          info => setHoverInfo(info),
        parameters:       { depthTest: false },
      }))
    }

    return lys
  }, [bgRoutes, top4Routes, animProgress, selectedRank, isNavigating, userLocation, endpoints, allRoutes, onSelectRoute])

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
        <Map reuseMaps mapStyle={MAP_STYLE} mapLib={maplibregl} />

        {hoverInfo && hoverInfo.object && !isNavigating && (
          <div className="deck-tooltip" style={{ left: hoverInfo.x + 12, top: hoverInfo.y + 12 }}>
            {hoverInfo.layer?.id === 'endpoints' ? (
              <strong>{hoverInfo.object.name?.replace(/_/g, ' ')}</strong>
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

      {/* Legend */}
      <div className="map-legend">
        <div className="map-legend-title">{isNavigating ? 'Live Navigation' : 'Routing Engine'}</div>
        {!isNavigating ? (
          <>
            <div className="legend-row"><span className="legend-line" style={{ background: '#22d472', height: 4 }} /><span>Best Route (#1)</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#4a9ef5', height: 3 }} /><span>Alt #2</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#f7b636', height: 3 }} /><span>Alt #3</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#c864f5', height: 3 }} /><span>Alt #4</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#6482a0', height: 1.5, opacity: 0.4 }} /><span>Background (46)</span></div>
          </>
        ) : (
          <>
            <div className="legend-row"><span className="legend-line" style={{ background: '#22d472', height: 4 }} /><span>Free Flow</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#f5a623', height: 4 }} /><span>Moderate</span></div>
            <div className="legend-row"><span className="legend-line" style={{ background: '#ff4f6d', height: 4 }} /><span>Heavy Traffic</span></div>
            {userLocation?.isSimulated && (
              <div className="legend-row">
                <span className="material-icons-round" style={{ fontSize: 16, color: '#f5a623' }}>warning</span>
                <span style={{ color: '#f5a623' }}>Simulating GPS</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Live badge */}
      <div className="map-live-badge">
        <span className="live-pulse" />
        <span>
          {isNavigating
            ? 'Live Traffic & GPS'
            : hasData
              ? `${result.routes_evaluated || allRoutes.length} paths evaluated via WebGL`
              : 'AI Map Engine – MMR Coverage'}
        </span>
      </div>

      {/* Re-route toast */}
      {rerouteEvent && (
        <div className="map-reroute-toast fade-in-up">
          <span className="material-icons-round">refresh</span>
          <div>
            <strong>Better Route Found!</strong>
            <p>Score: {rerouteEvent.old_score?.toFixed(3)} → {rerouteEvent.new_score?.toFixed(3)}</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasData && (
        <div className="map-empty-overlay">
          <span className="material-icons-round">route</span>
          <p>Enter any location in Mumbai, Navi Mumbai, Thane, Badlapur, Karjat…</p>
          <p style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: 4 }}>Real-world roads · 50 routes · AI ranked</p>
        </div>
      )}
    </div>
  )
}
