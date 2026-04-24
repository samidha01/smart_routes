import { useMemo } from 'react'
import { TIME_PERIODS, getTimePeriod } from '../services/trafficPenalty'
import './RouteList.css'

// ── Score bar ──────────────────────────────────────────────────────────────────
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

// ── FULL card — Top 4 routes ──────────────────────────────────────────────────
function RouteCardFull({
  route, rank, isSelected, onSelect,
  onNavigate, onReview, canNavigate,
  source, destination,
}) {
  const isBest = rank === 1
  const indicator = isBest ? 'best' : 'alt'
  const scoreQuality = Math.round((1 - (route.composite_score || 0)) * 100)
  const rankLabels = { 1: 'BEST', 2: '2nd', 3: '3rd', 4: '4th' }

  return (
    <button
      className={`rl-item rl-item-full ${isSelected ? 'selected' : ''} rl-${indicator}`}
      id={`route-rank-${rank}`}
      onClick={() => onSelect(rank)}
    >
      {/* Rank badge */}
      <div className="rl-rank-col">
        <div className={`rl-rank-badge rl-rank-${indicator}`}>#{rank}</div>
        <span className={`rl-rank-label rl-rank-label-${rank}`}>{rankLabels[rank]}</span>
      </div>

      {/* Main info */}
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

        {/* ── Direction / Review button on EVERY top-4 card ── */}
        <div className="rl-action-row">
          {canNavigate ? (
            // Source = GPS location → full live navigation
            <button
              type="button"
              className="rl-nav-btn"
              id={`rl-navigate-btn-${rank}`}
              onClick={e => { e.stopPropagation(); onNavigate(rank) }}
              title="Start GPS turn-by-turn navigation"
            >
              <span className="material-icons-round">navigation</span>
              <span>Start Navigation</span>
            </button>
          ) : (
            // Source = typed address → zoom to route only
            <button
              type="button"
              className="rl-review-btn"
              id={`rl-review-btn-${rank}`}
              onClick={e => { e.stopPropagation(); onReview(rank) }}
              title="Zoom map to fit this route"
            >
              <span className="material-icons-round">zoom_in_map</span>
              <span>Review Route</span>
            </button>
          )}
        </div>
      </div>

      {/* Score column */}
      <div className="rl-score-col">
        <span className="rl-score-val">{scoreQuality}</span>
        <span className="rl-score-lbl">score</span>
      </div>
    </button>
  )
}

// ── COMPACT card — Routes 5+ ───────────────────────────────────────────────────
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
        <span className="rl-compact-bar" style={{ width: `${scoreQuality}%` }} />
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

// ── Main Component ─────────────────────────────────────────────────────
export default function RouteList({
  result, selectedRank,
  onSelectRoute, onNavigateRoute, onReviewRoute,
  canNavigate,
  departureHour,
}) {
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

  // Detect active time period
  const periodId = departureHour != null ? getTimePeriod(departureHour) : 'AFTERNOON'
  const period = TIME_PERIODS[periodId]
  const isBaselineTime = periodId === 'AFTERNOON'

  // Build ordered list — rich data for top 4, summary for the rest
  const richByRank = new Map()
  richByRank.set(1, { rank: 1, ...result.best_route })
    ; (result.alternative_routes || []).forEach((r, i) => {
      const rank = i + 2
      richByRank.set(rank, { rank, ...r })
    })

  const summary = result.all_routes_summary || []
  let allRoutes = []

  if (summary.length > 0) {
    allRoutes = summary.map(s => {
      const rank = s.rank ?? s.index ?? (summary.indexOf(s) + 1)
      return richByRank.has(rank)
        ? { ...s, rank, ...richByRank.get(rank) }
        : { ...s, rank }
    })
  } else {
    allRoutes = [...richByRank.values()]
  }

  allRoutes.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))

  const topRoutes = allRoutes.filter(r => (r.rank ?? 999) <= 4)
  const restRoutes = allRoutes.filter(r => (r.rank ?? 999) > 4)

  return (
    <div className="route-list">

      {/* ── Header ── */}
        <div className="rl-header">
        <span className="material-icons-round">format_list_numbered</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="rl-title">Route Comparison</h3>
          <p className="rl-subtitle">
            {allRoutes.length} routes evaluated · Mode: {result.mode}
            {result.priority_stops_resolved > 0 &&
              ` · ${result.priority_stops_resolved} stop${result.priority_stops_resolved > 1 ? 's' : ''} via`}
          </p>
        </div>
        {/* Time period badge */}
        <div
          className="rl-time-badge"
          style={{
            borderColor: period.color,
            background: period.glowColor,
            color: period.color,
          }}
          title={`Ranked for ${period.label}: ${period.description}`}
        >
          <span className="rl-time-badge-emoji">{period.emoji}</span>
          <span className="rl-time-badge-label">{period.label}</span>
        </div>
      </div>

      {/* ── Navigation mode info banner ── */}
      {canNavigate ? (
        <div className="rl-nav-info rl-nav-info-gps">
          <span className="material-icons-round">gps_fixed</span>
          <span>GPS detected — <strong>Start Navigation</strong> enables live turn-by-turn</span>
        </div>
      ) : (
        <div className="rl-nav-info rl-nav-info-review">
          <span className="material-icons-round">zoom_in_map</span>
          <span><strong>Review Route</strong> zooms the map to fit each route</span>
        </div>
      )}

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

        {/* ── TOP 4 full cards ── */}
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
            onReview={onReviewRoute}
            canNavigate={canNavigate}
            source={result.source}
            destination={result.destination}
          />
        ))}

        {/* ── Routes 5+: compact list ── */}
        {restRoutes.length > 0 && (
          <>
            <div className="rl-section-label rl-section-rest">
              <span className="material-icons-round">list</span>
              All Evaluated
              <span className="rl-section-count">{restRoutes.length} more</span>
            </div>

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
