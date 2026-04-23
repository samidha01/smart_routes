import './StatsPanel.css'

const SCORE_DIMS = [
  { key: 'time',         label: 'Time',         icon: 'schedule',          color: '#4a9ef5' },
  { key: 'traffic',      label: 'Traffic',       icon: 'traffic',           color: '#f5a623' },
  { key: 'fuel',         label: 'Fuel',          icon: 'local_gas_station', color: '#22d472' },
  { key: 'weather',      label: 'Weather',       icon: 'cloud',             color: '#a78bfa' },
  { key: 'road_penalty', label: 'Road Quality',  icon: 'road',              color: '#fb923c' },
  { key: 'priority',     label: 'Priority Stops',icon: 'push_pin',          color: '#f472b6' },
]

function RadialScore({ value, size = 72 }) {
  const pct = Math.round((1 - Math.min(1, Math.max(0, value || 0))) * 100)
  const r   = (size - 10) / 2
  const circ = 2 * Math.PI * r
  const dash = ((pct / 100) * circ).toFixed(2)
  const gap  = (circ - dash).toFixed(2)
  const color = pct >= 70 ? '#22d472' : pct >= 45 ? '#f5a623' : '#ff4f6d'

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke="rgba(255,255,255,0.08)" strokeWidth={8} />
      <circle cx={size/2} cy={size/2} r={r} fill="none"
        stroke={color} strokeWidth={8}
        strokeDasharray={`${dash} ${gap}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`} />
      <text x={size/2} y={size/2 + 5} textAnchor="middle"
        fontSize={size * 0.22} fontWeight="800" fill={color} fontFamily="Manrope,sans-serif">
        {pct}
      </text>
    </svg>
  )
}

function ScoreDimBar({ dim, value }) {
  const quality = Math.round((1 - Math.min(1, Math.max(0, value || 0))) * 100)
  return (
    <div className="sp-dim-row">
      <span className="material-icons-round sp-dim-icon" style={{ color: dim.color }}>{dim.icon}</span>
      <div className="sp-dim-info">
        <div className="sp-dim-header">
          <span className="sp-dim-label">{dim.label}</span>
          <span className="sp-dim-val" style={{ color: dim.color }}>{quality}%</span>
        </div>
        <div className="sp-dim-track">
          <div className="sp-dim-fill" style={{ width: `${quality}%`, background: dim.color }} />
        </div>
      </div>
    </div>
  )
}

function MetricCard({ icon, label, value, unit, accent }) {
  return (
    <div className="sp-metric-card">
      <span className="material-icons-round sp-metric-icon" style={{ color: accent }}>{icon}</span>
      <div className="sp-metric-body">
        <span className="sp-metric-val">{value ?? '—'}<span className="sp-metric-unit">{unit}</span></span>
        <span className="sp-metric-label">{label}</span>
      </div>
    </div>
  )
}

export default function StatsPanel({ result, selectedRank, wsStatus }) {
  if (!result || !result.best_route) {
    return (
      <div className="stats-panel stats-panel-empty">
        <span className="material-icons-round">insights</span>
        <p>AI insights will appear here after generating routes</p>
        <div className="sp-ws-indicator" data-status={wsStatus || 'idle'}>
          <span className="sp-ws-dot" />
          <span>{wsStatus === 'connected' ? 'WebSocket Ready' : wsStatus === 'monitoring' ? 'Monitoring' : 'Idle'}</span>
        </div>
      </div>
    )
  }

  // Prefer selected route data; fall back to best
  const allRoutes = [
    { rank: 1, ...result.best_route },
    ...(result.alternative_routes || []).map((r, i) => ({ rank: i + 2, ...r })),
  ]
  const activeRoute = allRoutes.find(r => r.rank === selectedRank) || allRoutes[0]

  const breakdown   = activeRoute.score_breakdown || {}
  const vehicle     = result.vehicle || {}
  const context     = result.context || {}
  const traffic     = context.traffic || {}
  // weather comes as a formatted summary string from weather_summary()
  const weatherStr  = typeof context.weather === 'string' ? context.weather : ''
  // Parse condition from string like "Clear, 32°C (severity=0.05, src=simulated)"
  const weatherCond = weatherStr.split(',')[0] || '—'
  const weatherSevMatch = weatherStr.match(/severity=([\.\d]+)/)
  const weatherSev  = weatherSevMatch ? parseFloat(weatherSevMatch[1]) : null

  return (
    <div className="stats-panel">
      {/* Header */}
      <div className="sp-header">
        <span className="material-icons-round sp-header-icon">insights</span>
        <div>
          <h3 className="sp-title">AI Insights</h3>
          <p className="sp-subtitle">Rank #{activeRoute.rank} · {result.mode} mode</p>
        </div>
        <div className="sp-ws-indicator" data-status={wsStatus || 'idle'}>
          <span className="sp-ws-dot" />
          <span>{wsStatus === 'monitoring' ? 'Live' : wsStatus === 'connected' ? 'WS' : '—'}</span>
        </div>
      </div>

      {/* Composite score radial */}
      <div className="sp-score-section">
        <RadialScore value={activeRoute.composite_score} size={84} />
        <div className="sp-score-info">
          <p className="sp-score-title">AI Route Score</p>
          <p className="sp-score-sub">
            Composite of time, traffic, fuel, weather &amp; road quality
          </p>
          {activeRoute.ml_predicted_cost != null && (
            <p className="sp-ml-badge">
              <span className="material-icons-round">smart_toy</span>
              ML cost: {activeRoute.ml_predicted_cost.toFixed(3)}
            </p>
          )}
        </div>
      </div>

      {/* Key metrics */}
      <div className="sp-metrics-grid">
        <MetricCard icon="schedule" label="ETA"
          value={activeRoute.estimated_time_min != null ? Math.round(activeRoute.estimated_time_min) : null}
          unit=" min" accent="#4a9ef5" />
        <MetricCard icon="straighten" label="Distance"
          value={activeRoute.distance_km != null ? activeRoute.distance_km.toFixed(1) : null}
          unit=" km" accent="#22d472" />
        <MetricCard icon="local_gas_station" label="Fuel Est."
          value={activeRoute.fuel_estimate != null ? activeRoute.fuel_estimate.toFixed(2) : null}
          unit=" L" accent="#f5a623" />
        <MetricCard icon="alt_route" label="Stops"
          value={(activeRoute.path || []).length - 1}
          unit="" accent="#a78bfa" />
      </div>

      {/* Score breakdown */}
      <div className="sp-section">
        <p className="sp-section-label">Score Breakdown</p>
        <div className="sp-dims">
          {SCORE_DIMS.map(d => (
            <ScoreDimBar key={d.key} dim={d} value={breakdown[d.key] ?? 0} />
          ))}
        </div>
      </div>

      {/* Vehicle */}
      <div className="sp-section">
        <p className="sp-section-label">Vehicle Profile</p>
        <div className="sp-vehicle-row">
          <span className="material-icons-round sp-vehicle-icon">
            {vehicle.type === 'bike' ? 'two_wheeler' : vehicle.type === 'truck' ? 'local_shipping' : vehicle.type === 'tempo' ? 'airport_shuttle' : 'directions_car'}
          </span>
          <div className="sp-vehicle-info">
            <p className="sp-vehicle-name">
              {[vehicle.brand, vehicle.model].filter(Boolean).join(' ') || vehicle.type || 'Vehicle'}
            </p>
            <p className="sp-vehicle-sub">
              {vehicle.mileage ? `${vehicle.mileage} km/L` : ''}
              {vehicle.mileage && vehicle.fuel_type ? ' · ' : ''}
              {vehicle.fuel_type || ''}
            </p>
          </div>
        </div>
      </div>

      {/* Context: Traffic + Weather */}
      <div className="sp-section">
        <p className="sp-section-label">Live Conditions</p>
        <div className="sp-context-row">
          {/* Traffic */}
          <div className="sp-context-card">
            <span className="material-icons-round" style={{ color: '#f5a623' }}>traffic</span>
            <div>
              <p className="sp-ctx-title">Traffic</p>
              <p className="sp-ctx-val">{traffic.avg != null ? `${(traffic.avg * 100).toFixed(0)}% density` : '—'}</p>
              <p className="sp-ctx-sub">{traffic.source ? `src: ${traffic.source}` : `${traffic.count ?? 0} segments`}</p>
            </div>
          </div>
          {/* Weather */}
          <div className="sp-context-card">
            <span className="material-icons-round" style={{ color: '#a78bfa' }}>wb_cloudy</span>
            <div>
              <p className="sp-ctx-title">Weather</p>
              <p className="sp-ctx-val">{weatherCond || '—'}</p>
              <p className="sp-ctx-sub">
                {weatherSev != null ? `Severity: ${(weatherSev * 100).toFixed(0)}%` : ''}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Savings vs next best */}
      {result.savings && (
        <div className="sp-section">
          <p className="sp-section-label">Savings vs Rank #2</p>
          <div className="sp-savings-row">
            <div className="sp-saving">
              <span className="material-icons-round">schedule</span>
              <strong>{result.savings.time_saved_min?.toFixed(1)} min</strong>
              <span>{result.savings.time_saved_pct}% faster</span>
            </div>
            <div className="sp-saving">
              <span className="material-icons-round">local_gas_station</span>
              <strong>{result.savings.fuel_saved?.toFixed(3)} L</strong>
              <span>{result.savings.fuel_saved_pct}% less fuel</span>
            </div>
          </div>
        </div>
      )}

      {/* Session info */}
      <div className="sp-session">
        <span className="material-icons-round">fingerprint</span>
        <span className="sp-session-id">Session: {result.session_id?.slice(0, 12)}…</span>
      </div>
    </div>
  )
}
