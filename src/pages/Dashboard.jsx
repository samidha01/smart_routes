import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import ControlPanel from '../components/ControlPanel'
import MapView from '../components/MapView'
import RouteList from '../components/RouteList'
import StatsPanel from '../components/StatsPanel'
import TrafficPopup, { analyseTraffic } from '../components/TrafficPopup'
import TimeSlider from '../components/TimeSlider'
import { optimizeRoute, openRerouteSocket } from '../services/api'
import { useGeolocation } from '../hooks/useGeolocation'
import { getCurrentHour, getTimePeriod, applyTrafficPenalty } from '../services/trafficPenalty'
import './Dashboard.css'

export default function Dashboard() {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedRank, setSelectedRank] = useState(1)
  const [wsStatus, setWsStatus] = useState('idle')   // idle | connected | monitoring
  const [rerouteEvent, setRerouteEvent] = useState(null)
  const [toast, setToast] = useState(null)
  const [activeTab, setActiveTab] = useState('routes') // routes | stats (mobile)
  const [isNavigating, setIsNavigating] = useState(false)
  const [fuelStations, setFuelStations] = useState([])       // [{lat,lon,name}]
  const [fuelCritical, setFuelCritical] = useState(false)
  const [sourceIsGPS, setSourceIsGPS] = useState(false)    // true when My Location was used
  const [trafficAlert, setTrafficAlert] = useState(null)   // Holds the current traffic alert to show in popup
  // ── Time Machine (Departure Time Slider) ──────────────────────────────────
  const [departureHour, setDepartureHour] = useState(() => getCurrentHour())
  const wsRef = useRef(null)
  const rerouteTimer = useRef(null)

  // ── Time-adjusted (re-ranked) result ─────────────────────────────────────
  // Flatten all routes into one list, apply penalty, re-rank purely on frontend.
  // No API call, no page reload.
  const timeAdjustedResult = useMemo(() => {
    if (!result) return null

    // Build a flat list of all routes with full data
    const richByRank = new Map()
    richByRank.set(1, { rank: 1, ...result.best_route })
    ;(result.alternative_routes || []).forEach((r, i) => {
      richByRank.set(i + 2, { rank: i + 2, ...r })
    })

    const summary = result.all_routes_summary || []
    let allRoutes = []
    if (summary.length > 0) {
      allRoutes = summary.map(s => {
        const rank = s.rank ?? (summary.indexOf(s) + 1)
        return richByRank.has(rank) ? { ...s, rank, ...richByRank.get(rank) } : { ...s, rank }
      })
    } else {
      allRoutes = [...richByRank.values()]
    }

    const periodId = getTimePeriod(departureHour)
    // Only re-rank if not AFTERNOON (baseline) — otherwise keep original order
    const penalized = applyTrafficPenalty(allRoutes, periodId)

    // Build a new result shaped like the original but with penalized ranks
    const newBest   = penalized[0] || null
    const newAlts   = penalized.slice(1, 4)
    const newSummary = penalized.map(r => ({
      rank:               r.rank,
      composite_score:    r.time_adjusted_score ?? r.composite_score,
      distance_km:        r.distance_km,
      estimated_time_min: r.estimated_time_min,
      fuel_estimate:      r.fuel_estimate,
      path_geometry:      r.path_geometry ?? r.path ?? [],
      segments:           r.segments ?? [],
      traffic_road_type:  r.traffic_road_type,
      traffic_penalty_applied: r.traffic_penalty_applied,
    }))

    return {
      ...result,
      best_route:         newBest ? { ...newBest, rank: 1 } : result.best_route,
      alternative_routes: newAlts.map((r, i) => ({ ...r, rank: i + 2 })),
      all_routes_summary: newSummary,
      _time_period:       periodId,
      _departure_hour:    departureHour,
    }
  }, [result, departureHour])

  const activeRoute = useMemo(() => {
    if (!timeAdjustedResult) return null;
    if (selectedRank === 1) return timeAdjustedResult.best_route;
    const alt = (timeAdjustedResult.alternative_routes || []).find(r => (r.rank || timeAdjustedResult.alternative_routes.indexOf(r) + 2) === selectedRank);
    if (alt) return alt;
    return (timeAdjustedResult.all_routes_summary || []).find(r => r.rank === selectedRank) || null;
  }, [timeAdjustedResult, selectedRank]);

  const { location } = useGeolocation(isNavigating, activeRoute);

  // ── Toast helper ──────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4500)
  }

  // ── WebSocket handling ────────────────────────────────────────────────────
  function connectWS(sessionId) {
    if (wsRef.current) wsRef.current.close()
    setWsStatus('connected')
    const handle = openRerouteSocket(sessionId, (data) => {
      if (data.event === 'connected') setWsStatus('monitoring')
      if (data.event === 'heartbeat') setWsStatus('monitoring')
      if (data.event === 'reroute_update') {
        setRerouteEvent(data)
        showToast(`Better route found! Score: ${data.new_score?.toFixed(3)}`, 'success')
        // Clear after 6s
        clearTimeout(rerouteTimer.current)
        rerouteTimer.current = setTimeout(() => setRerouteEvent(null), 6000)
      }
    })
    wsRef.current = handle
  }

  useEffect(() => {
    return () => {
      wsRef.current?.close()
      clearTimeout(rerouteTimer.current)
    }
  }, [])

  // ── Fuel station fetch (Overpass API) ───────────────────────────────────────
  async function fetchFuelStations(lat, lon, radiusM = 8000) {
    try {
      const q = `[out:json][timeout:10];node[amenity=fuel](around:${radiusM},${lat},${lon});out body;`
      const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
      const data = await res.json()
      return (data.elements || []).map(el => ({
        lat: el.lat, lon: el.lon,
        name: el.tags?.name || el.tags?.brand || 'Fuel Station',
        brand: el.tags?.brand || '',
      }))
    } catch (e) {
      console.warn('[FuelStations] Overpass fetch failed:', e)
      return []
    }
  }

  // ── Generate routes ───────────────────────────────────────────────────────
  const handleGenerate = useCallback(async (formData) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setSelectedRank(1)
    setIsNavigating(false)
    setRerouteEvent(null)
    wsRef.current?.close()
    setWsStatus('idle')

    try {
      const data = await optimizeRoute(formData)
      setResult(data)
      setSelectedRank(1)
      showToast(`${data.routes_evaluated} routes evaluated in ${data.computation_time_s}s`, 'success')
      // Open WebSocket for rerouting
      if (data.session_id) connectWS(data.session_id)

      // Show fuel stations at yellow (≤45%) OR red (≤20%) — early warning
      const fuelLvl = formData.fuel_level ?? 75
      const mileage = parseFloat(formData.mileage) || 15
      const TANK_L = 45
      const fuelL = (fuelLvl / 100) * TANK_L
      const rangeKm = fuelL * mileage
      const distKm = data.best_route?.distance_km ?? 0
      const mathCrit = rangeKm < distKm * 1.10   // mathematically can't make it
      const lowFuel = fuelLvl <= 45             // yellow or red slider state
      const needStations = mathCrit || lowFuel

      setFuelCritical(needStations)

      if (needStations && data.source_coords?.lat != null) {
        const sc = data.source_coords
        const dc = data.dest_coords
        const midLat = dc?.lat != null ? (sc.lat + dc.lat) / 2 : sc.lat
        const midLon = dc?.lon != null ? (sc.lon + dc.lon) / 2 : sc.lon
        const stations = await fetchFuelStations(midLat, midLon, 8000)
        setFuelStations(stations.slice(0, 10))
        if (stations.length > 0) {
          const lvlLabel = fuelLvl <= 20 ? 'Critical' : 'Low'
          showToast(`⛽ ${lvlLabel} fuel — ${stations.length} stations mapped`, fuelLvl <= 20 ? 'error' : 'info')
        }
      } else {
        setFuelStations([])
      }
    } catch (err) {
      setError(err.message || 'Failed to reach backend. Is the server running?')
      showToast(err.message || 'Request failed', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Recalculate (re-run last query) ───────────────────────────────────────
  const lastFormRef = useRef(null)
  const handleGenerateWithRef = useCallback(async (formData) => {
    lastFormRef.current = formData
    await handleGenerate(formData)
  }, [handleGenerate])

  // ── Review Route (zoom to fit, no navigation) ─────────────────────────────
  const handleSelectRoute = useCallback((rank) => {
    setSelectedRank(rank)
    setIsNavigating(false)
    
    // Traffic popup check (use time-adjusted result)
    if (timeAdjustedResult) {
      const allRoutes = [
        { rank: 1, ...timeAdjustedResult.best_route },
        ...(timeAdjustedResult.alternative_routes || []).map((r, i) => ({ rank: i + 2, ...r })),
        ...(timeAdjustedResult.all_routes_summary || [])
      ]
      const selected = allRoutes.find(r => r.rank === rank)
      if (selected) {
        setTrafficAlert(analyseTraffic(selected))
      }
    }
  }, [timeAdjustedResult])

  const handleReviewRoute = useCallback((rank) => {
    handleSelectRoute(rank)
    // MapView auto-zooms to the selected route bounds via its selectedRank effect
  }, [handleSelectRoute])

  const canNavigate = useMemo(() => {
    if (!location || location.isSimulated || !timeAdjustedResult) return false;
    const bestRoute = timeAdjustedResult.best_route;
    if (bestRoute && bestRoute.path_geometry && bestRoute.path_geometry.length > 0) {
      const srcCoord = bestRoute.path_geometry[0];
      const dx = location.longitude - srcCoord[0];
      const dy = location.latitude - srcCoord[1];
      const dist = Math.sqrt(dx * dx + dy * dy) * 111; // Approx km
      return dist < 2.0; // Within 2km of source
    }
    return false;
  }, [location, timeAdjustedResult]);

  function handleRecalculate() {
    if (lastFormRef.current) handleGenerate(lastFormRef.current)
  }

  // ── Departure hour change handler ─────────────────────────────────────────
  const handleDepartureHourChange = useCallback((newHour) => {
    setDepartureHour(newHour)
    setSelectedRank(1)  // Reset to best route when time changes
  }, [])

  return (
    <div className="dashboard-page">

      {/* ── Global toast ── */}
      {toast && (
        <div className={`db-toast db-toast-${toast.type} fade-in-up`}>
          <span className="material-icons-round">
            {toast.type === 'success' ? 'check_circle' : toast.type === 'error' ? 'error' : 'info'}
          </span>
          {toast.msg}
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div className="db-error-banner">
          <span className="material-icons-round">warning</span>
          <span>{error}</span>
          <button onClick={() => setError(null)} className="db-error-close">
            <span className="material-icons-round">close</span>
          </button>
        </div>
      )}

      <div className="dashboard-layout">
        {/* ══ LEFT: Control Panel ══ */}
        <aside className="db-left">
          <ControlPanel onSubmit={handleGenerateWithRef} loading={loading} />
        </aside>

        {/* ══ CENTER: Map ══ */}
        <main className="db-center">
          {/* Action bar */}
          <div className="db-action-bar">
            <div className="db-action-info">
              {result ? (
                <span>
                  <strong>{result.routes_evaluated}</strong> routes ·{' '}
                  <strong>{result.source?.replace(/_/g, ' ')}</strong>
                  {' → '}
                  <strong>{result.destination?.replace(/_/g, ' ')}</strong>
                </span>
              ) : (
                <span className="db-action-idle">No routes generated yet</span>
              )}
            </div>
            <div className="db-action-btns">
              <button className="db-action-btn" id="db-recalculate-btn"
                onClick={handleRecalculate} disabled={loading || !lastFormRef.current}
                title="Recalculate Route">
                <span className="material-icons-round">refresh</span>
                <span>Recalculate</span>
              </button>
            </div>
          </div>

          <div className="db-map-wrap">
            <MapView
              result={timeAdjustedResult}
              selectedRank={selectedRank}
              onSelectRoute={(rank) => { setSelectedRank(rank); setIsNavigating(false); }}
              rerouteEvent={rerouteEvent}
              isNavigating={isNavigating}
              onEndNavigation={() => { setIsNavigating(false); }}
              userLocation={location}
              fuelStations={fuelStations}
              fuelCritical={fuelCritical}
            />

            {/* ── Time Machine Slider — appears over map after routes load ── */}
            <TimeSlider
              visible={!!result && !loading}
              hour={departureHour}
              onChange={handleDepartureHourChange}
            />

            {/* Loading overlay */}
            {loading && (
              <div className="db-loading-overlay fade-in-up">
                <div className="db-loading-card">
                  <div className="db-spinner" />
                  <div>
                    <p className="db-loading-title">AI Routing Engine</p>
                    <p className="db-loading-sub">Evaluating 50+ candidate routes…</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>

        {/* ══ RIGHT: Tabs → RouteList + StatsPanel ══ */}
        <aside className="db-right">
          <div className="db-right-tabs">
            <button
              className={`db-right-tab ${activeTab === 'routes' ? 'active' : ''}`}
              id="db-tab-routes"
              onClick={() => setActiveTab('routes')}
            >
              <span className="material-icons-round">format_list_numbered</span>
              Routes
            </button>
            <button
              className={`db-right-tab ${activeTab === 'stats' ? 'active' : ''}`}
              id="db-tab-stats"
              onClick={() => setActiveTab('stats')}
            >
              <span className="material-icons-round">insights</span>
              AI Stats
            </button>
          </div>

          <div className="db-right-content">
            {activeTab === 'routes' ? (
              <RouteList
                result={timeAdjustedResult}
                selectedRank={selectedRank}
                onSelectRoute={handleSelectRoute}
                onNavigateRoute={(rank) => { handleSelectRoute(rank); setIsNavigating(true); }}
                onReviewRoute={handleReviewRoute}
                canNavigate={canNavigate}
                departureHour={departureHour}
              />
            ) : (
              <StatsPanel
                result={timeAdjustedResult}
                selectedRank={selectedRank}
                wsStatus={wsStatus}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
