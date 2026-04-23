import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import ControlPanel from '../components/ControlPanel'
import MapView from '../components/MapView'
import RouteList from '../components/RouteList'
import StatsPanel from '../components/StatsPanel'
import { optimizeRoute, openRerouteSocket } from '../services/api'
import { useGeolocation } from '../hooks/useGeolocation'
import './Dashboard.css'

export default function Dashboard() {
  const [result,        setResult]        = useState(null)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [selectedRank,  setSelectedRank]  = useState(1)
  const [wsStatus,      setWsStatus]      = useState('idle')   // idle | connected | monitoring
  const [rerouteEvent,  setRerouteEvent]  = useState(null)
  const [toast,         setToast]         = useState(null)
  const [activeTab,     setActiveTab]     = useState('routes') // routes | stats (mobile)
  const [isNavigating,  setIsNavigating]  = useState(false)
  const wsRef = useRef(null)
  const rerouteTimer = useRef(null)

  const activeRoute = useMemo(() => {
    if (!result) return null;
    if (selectedRank === 1) return result.best_route;
    const alt = (result.alternative_routes || []).find(r => (r.rank || result.alternative_routes.indexOf(r) + 2) === selectedRank);
    if (alt) return alt;
    return (result.all_routes_summary || []).find(r => r.rank === selectedRank) || null;
  }, [result, selectedRank]);

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
      if (data.event === 'connected')   setWsStatus('monitoring')
      if (data.event === 'heartbeat')   setWsStatus('monitoring')
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

  const canNavigate = useMemo(() => {
    if (!location || location.isSimulated || !result) return false;
    if (result.best_route && result.best_route.path_geometry && result.best_route.path_geometry.length > 0) {
      const srcCoord = result.best_route.path_geometry[0];
      const dx = location.longitude - srcCoord[0];
      const dy = location.latitude - srcCoord[1];
      const dist = Math.sqrt(dx*dx + dy*dy) * 111; // Approx km
      return dist < 2.0; // Within 2km of source
    }
    return false;
  }, [location, result]);

  function handleRecalculate() {
    if (lastFormRef.current) handleGenerate(lastFormRef.current)
  }

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
                  <strong>{result.source?.replace(/_/g,' ')}</strong>
                  {' → '}
                  <strong>{result.destination?.replace(/_/g,' ')}</strong>
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
              result={result}
              selectedRank={selectedRank}
              onSelectRoute={(rank) => { setSelectedRank(rank); setIsNavigating(false); }}
              rerouteEvent={rerouteEvent}
              isNavigating={isNavigating}
              userLocation={location}
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
                result={result}
                selectedRank={selectedRank}
                onSelectRoute={(rank) => { setSelectedRank(rank); setIsNavigating(false); }}
                onNavigateRoute={(rank) => { setSelectedRank(rank); setIsNavigating(true); }}
                canNavigate={canNavigate}
              />
            ) : (
              <StatsPanel
                result={result}
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
