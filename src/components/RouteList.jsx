import './RouteList.css'

// ── Score bar (used in full cards only) ─────────────────────────────────────
function ScoreBar({ value }) {
  const pct = Math.round((1 - (value || 0)) * 100)
  return (
    <div className="score-bar-wrap">
      <div className="score-bar-track">
        <div className="score-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="score-bar-val">{pct}</span>
    </div>
  )
}

// ── FULL card — Top 4 routes ─────────────────────────────────────────────────
function RouteCardFull({ route, rank, isSelected, onSelect, onNavigate, canNavigate, source, destination }) {
  const isBest    = rank === 1
  const indicator = isBest ? 'best' : 'alt'
  const scoreQuality = Math.round((1 - (route.composite_score || 0)) * 100)

  const rankLabels = { 1: 'BEST', 2: '2nd', 3: '3rd', 4: '4th' }

  return (
    <button
      className={`rl-item rl-item-full ${isSelected ? 'selected' : ''} rl-${indicator}`}
      id={`route-rank-${rank}`}
      onClick={() => onSelect(rank)}
    >
      <div className="rl-rank-col">
        <div className={`rl-rank-badge rl-rank-${indicator}`}>#{rank}</div>
        <span className={`rl-rank-label rl-rank-label-${rank}`}>{rankLabels[rank]}</span>
      </div>

      <div className="rl-info">
        <div className="rl-path">
          <span className="rl-path-text">{source?.replace(/_/g, ' ')}</span>
          <span className="material-icons-round rl-arrow">arrow_forward</span>
          <span className="rl-path-text">{destination?.replace(/_/g, ' ')}</span>
        </div>

        <div className="rl-metrics">
          <span className="rl-metric">
            <span className="material-icons-round">schedule</span>
            {route.estimated_time_min != null ? `${Math.round(route.estimated_time_min)} min` : '—'}
          </span>
          <span className="rl-metric">
            <span className="material-icons-round">straighten</span>
            {route.distance_km != null ? `${route.distance_km.toFixed(1)} km` : '—'}
          </span>
          <span className="rl-metric">
            <span className="material-icons-round">local_gas_station</span>
            {route.fuel_estimate != null ? `${route.fuel_estimate.toFixed(2)} L` : '—'}
          </span>
        </div>

        <ScoreBar value={route.composite_score} />

        {isBest && onNavigate && (
          <button
            type="button"
            className={`rl-nav-btn${canNavigate ? '' : ' rl-nav-btn-sim'}`}
            id="rl-start-nav-btn"
            onClick={e => { e.stopPropagation(); onNavigate(rank) }}
            title={canNavigate ? 'Start real GPS navigation' : 'Simulate navigation along route'}
          >
            <span className="material-icons-round">navigation</span>
            <span>{canNavigate ? 'Start Navigation' : 'Simulate Drive'}</span>
          </button>
        )}
      </div>

      <div className="rl-score-col">
        <span className="rl-score-val">{scoreQuality}</span>
        <span className="rl-score-lbl">score</span>
      </div>
    </button>
  )
}

// ── COMPACT card — Routes 5–50 (monochromatic) ───────────────────────────────
function RouteCardCompact({ route, rank, isSelected, onSelect }) {
  const scoreQuality = Math.round((1 - (route.composite_score || 0)) * 100)
  return (
    <button
      className={`rl-item rl-item-compact${isSelected ? ' rl-item-compact-selected' : ''}`}
      id={`route-rank-${rank}`}
      onClick={() => onSelect(rank)}
      title={`Route #${rank} — ${route.estimated_time_min != null ? Math.round(route.estimated_time_min) + ' min' : ''} · ${route.distance_km != null ? route.distance_km.toFixed(1) + ' km' : ''}`}
    >
      <span className="rl-compact-rank">#{rank}</span>
      <span className="rl-compact-bar-wrap">
        <span
          className="rl-compact-bar"
          style={{ width: `${scoreQuality}%` }}
        />
      </span>
      <span className="rl-compact-time">
        {route.estimated_time_min != null ? `${Math.round(route.estimated_time_min)}m` : '—'}
      </span>
      <span className="rl-compact-dist">
        {route.distance_km != null ? `${route.distance_km.toFixed(1)}k` : '—'}
      </span>
      <span className="rl-compact-fuel">
        {route.fuel_estimate != null ? `${route.fuel_estimate.toFixed(1)}L` : '—'}
      </span>
      <span className="rl-compact-score">{scoreQuality}</span>
    </button>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function RouteList({ result, selectedRank, onSelectRoute, onNavigateRoute, canNavigate }) {
  if (!result || !result.best_route) {
    return (
      <div className="route-list-empty">
        <span className="material-icons-round">route</span>
        <p>Routes will appear here after generation</p>
        <p style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: 6 }}>
          Supports any location in Mumbai, Navi Mumbai, Thane, Badlapur, Karjat…
        </p>
      </div>
    )
  }

  // ── Build complete ordered list ───────────────────────────────────────────
  // Strategy:
  //   1. all_routes_summary = authoritative list of ALL scored routes (up to 50)
  //   2. For ranks 1-4 we also have richer objects (best_route, alternative_routes)
  //      — use them so we get path_geometry + segments
  //   3. Sort by rank ascending

  const richByRank = new Map()

  // Rank 1 — best route
  richByRank.set(1, { rank: 1, ...result.best_route })

  // Ranks 2-4 — alternative routes
  ;(result.alternative_routes || []).forEach((r, i) => {
    const rank = i + 2
    richByRank.set(rank, { rank, ...r })
  })

  // Build master list from all_routes_summary (all 50) if available
  const summary = result.all_routes_summary || []
  let allRoutes = []

  if (summary.length > 0) {
    // Use summary as base — override top-4 with rich objects
    allRoutes = summary.map(s => {
      const rank = s.rank ?? s.index ?? (summary.indexOf(s) + 1)
      return richByRank.has(rank)
        ? { ...s, rank, ...richByRank.get(rank) }
        : { ...s, rank }
    })
  } else {
    // Fallback: only top 4
    allRoutes = [...richByRank.values()]
  }

  // Sort by rank
  allRoutes.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))

  const topRoutes  = allRoutes.filter(r => (r.rank ?? 999) <= 4)
  const restRoutes = allRoutes.filter(r => (r.rank ?? 999) > 4)

  return (
    <div className="route-list">

      {/* ── Header ── */}
      <div className="rl-header">
        <span className="material-icons-round">format_list_numbered</span>
        <div>
          <h3 className="rl-title">Route Comparison</h3>
          <p className="rl-subtitle">
            {allRoutes.length} routes evaluated · Mode: {result.mode}
            {result.priority_stops_resolved > 0 &&
              ` · ${result.priority_stops_resolved} stop${result.priority_stops_resolved > 1 ? 's' : ''} via`}
          </p>
        </div>
      </div>

      {/* ── Savings banner ── */}
      {result.savings && (result.savings.time_saved_min > 0 || result.savings.fuel_saved > 0) && (
        <div className="rl-savings">
          <span className="material-icons-round">savings</span>
          <span>
            Best saves&nbsp;
            {result.savings.time_saved_min > 0 && <strong>{result.savings.time_saved_min.toFixed(1)} min</strong>}
            {result.savings.time_saved_min > 0 && result.savings.fuel_saved > 0 && ' · '}
            {result.savings.fuel_saved > 0 && <strong>{result.savings.fuel_saved.toFixed(2)} L fuel</strong>}
            &nbsp;vs next best
          </span>
        </div>
      )}

      <div className="rl-routes">

        {/* ── TOP 4: Highlighted full cards ── */}
        <div className="rl-section-label rl-section-top">
          <span className="material-icons-round">star</span>
          Top Routes
          <span className="rl-section-count">{topRoutes.length}</span>
        </div>

        {topRoutes.map(route => (
          <RouteCardFull
            key={route.rank}
            route={route}
            rank={route.rank}
            isSelected={selectedRank === route.rank}
            onSelect={onSelectRoute}
            onNavigate={onNavigateRoute}
            canNavigate={canNavigate}
            source={result.source}
            destination={result.destination}
          />
        ))}

        {/* ── ROUTES 5–50: Monochromatic compact cards ── */}
        {restRoutes.length > 0 && (
          <>
            <div className="rl-section-label rl-section-rest">
              <span className="material-icons-round">list</span>
              All Evaluated
              <span className="rl-section-count">{restRoutes.length} more</span>
            </div>

            {/* Compact table header */}
            <div className="rl-compact-header">
              <span>#</span>
              <span style={{ flex: 1 }}>score</span>
              <span>time</span>
              <span>dist</span>
              <span>fuel</span>
              <span>pts</span>
            </div>

            {restRoutes.map(route => (
              <RouteCardCompact
                key={route.rank}
                route={route}
                rank={route.rank}
                isSelected={selectedRank === route.rank}
                onSelect={onSelectRoute}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
