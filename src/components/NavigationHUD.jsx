import { useEffect, useState } from 'react'
import './NavigationHUD.css'

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function bearingDeg(p1, p2) {
  const [lon1, lat1] = p1
  const [lon2, lat2] = p2
  const dLon = (lon2 - lon1) * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180)
  const x =
    Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function turnAngle(p0, p1, p2) {
  const b1 = bearingDeg(p0, p1)
  const b2 = bearingDeg(p1, p2)
  let a = b2 - b1
  if (a > 180) a -= 360
  if (a < -180) a += 360
  return a
}

/** Find index of closest point on path to [lat, lon] */
function closestIdx(path, lat, lon) {
  let best = 0, bestD = Infinity
  path.forEach(([pLon, pLat], i) => {
    const d = (pLon - lon) ** 2 + (pLat - lat) ** 2
    if (d < bestD) { bestD = d; best = i }
  })
  return best
}

/** Determine next maneuver from current position on path */
function getManeuver(path, idx) {
  const ARRIVE_THRESH = 3   // indices from end = "arriving"

  if (idx >= path.length - ARRIVE_THRESH) {
    return { icon: 'location_on', text: 'You have arrived!', color: '#22d472', type: 'arrive' }
  }

  // Look ahead a few points for a real turn
  const lookAhead = Math.min(idx + 5, path.length - 2)
  const p0 = path[Math.max(0, idx - 1)]
  const p1 = path[idx]
  const p2 = path[lookAhead]

  const angle = p0 && p1 && p2 ? turnAngle(p0, p1, p2) : 0

  if (angle > 130)  return { icon: 'u_turn_right',    text: 'Make a U-turn',  color: '#ff4f6d', type: 'uturn'  }
  if (angle > 50)   return { icon: 'turn_right',       text: 'Turn right',     color: '#f5a623', type: 'right'  }
  if (angle > 20)   return { icon: 'turn_slight_right',text: 'Keep right',     color: '#4a9ef5', type: 'slight' }
  if (angle < -130) return { icon: 'u_turn_left',      text: 'Make a U-turn',  color: '#ff4f6d', type: 'uturn'  }
  if (angle < -50)  return { icon: 'turn_left',        text: 'Turn left',      color: '#f5a623', type: 'left'   }
  if (angle < -20)  return { icon: 'turn_slight_left', text: 'Keep left',      color: '#4a9ef5', type: 'slight' }
  return               { icon: 'straight',             text: 'Continue straight', color: '#22d472', type: 'straight' }
}

/** Remaining distance from pathIdx to end, in km */
function remainingKm(path, fromIdx) {
  let d = 0
  for (let i = fromIdx; i < path.length - 1; i++) {
    d += haversineKm(path[i][1], path[i][0], path[i + 1][1], path[i + 1][0])
  }
  return d
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NavigationHUD({ route, userLocation, onEnd }) {
  const path = route?.path_geometry || []

  const [progress,  setProgress]  = useState(0)
  const [maneuver,  setManeuver]  = useState({ icon: 'navigation', text: 'Starting…', color: '#4a9ef5', type: 'straight' })
  const [remKm,     setRemKm]     = useState(route?.distance_km ?? 0)
  const [remMin,    setRemMin]     = useState(route?.estimated_time_min ?? 0)
  const [arrived,   setArrived]   = useState(false)

  // Distance to next turn
  const [turnDist,  setTurnDist]  = useState(null)

  useEffect(() => {
    if (!path.length || !userLocation) return

    const idx     = closestIdx(path, userLocation.latitude, userLocation.longitude)
    const pct     = path.length > 1 ? idx / (path.length - 1) : 0
    const remD    = remainingKm(path, idx)
    const totalD  = route?.distance_km || 0
    const totalT  = route?.estimated_time_min || 0
    const remT    = totalD > 0 ? (remD / totalD) * totalT : 0

    setProgress(pct * 100)
    setRemKm(remD)
    setRemMin(remT)

    // Check arrival (within 80m of end)
    const [eLon, eLat] = path[path.length - 1]
    const distToEnd = haversineKm(userLocation.latitude, userLocation.longitude, eLat, eLon)
    if (distToEnd < 0.08) {
      setArrived(true)
      setManeuver({ icon: 'location_on', text: 'You have arrived!', color: '#22d472', type: 'arrive' })
      return
    }

    const m = getManeuver(path, idx)
    setManeuver(m)

    // Distance to the next turn point
    if (m.type !== 'straight' && m.type !== 'arrive') {
      // Find closest index in ahead-path where angle changes significantly
      const nextTurnPt = Math.min(idx + 5, path.length - 2)
      const dToTurn = haversineKm(
        userLocation.latitude, userLocation.longitude,
        path[nextTurnPt][1], path[nextTurnPt][0]
      )
      setTurnDist(dToTurn)
    } else {
      setTurnDist(null)
    }
  }, [userLocation, path, route])

  const speedKmh = userLocation?.speed != null && userLocation.speed > 0
    ? Math.round(userLocation.speed * 3.6)
    : null

  function fmtDist(km) {
    if (km < 0.1) return `${Math.round(km * 1000)} m`
    if (km < 1)   return `${Math.round(km * 10) / 10} km`
    return `${km.toFixed(1)} km`
  }

  return (
    <div className={`nav-hud${arrived ? ' nav-hud-arrived' : ''}`}>

      {/* ── Top: maneuver instruction ── */}
      <div className="nav-hud-top" style={{ '--hud-accent': maneuver.color }}>

        <div className="nav-hud-icon-wrap" style={{ background: `${maneuver.color}22`, borderColor: `${maneuver.color}44` }}>
          <span className="material-icons-round" style={{ color: maneuver.color }}>
            {maneuver.icon}
          </span>
        </div>

        <div className="nav-hud-text">
          <span className="nav-hud-action">{maneuver.text}</span>
          {turnDist != null && (
            <span className="nav-hud-sub">in {fmtDist(turnDist)}</span>
          )}
          {maneuver.type === 'straight' && remKm > 0.05 && (
            <span className="nav-hud-sub">{fmtDist(remKm)} to destination</span>
          )}
        </div>

        {speedKmh !== null && (
          <div className="nav-hud-speedbox">
            <span className="nav-hud-speed-val">{speedKmh}</span>
            <span className="nav-hud-speed-unit">km/h</span>
          </div>
        )}
      </div>

      {/* ── Progress bar ── */}
      <div className="nav-hud-progress-track">
        <div
          className="nav-hud-progress-fill"
          style={{ width: `${Math.min(100, progress)}%`, background: maneuver.color }}
        />
      </div>

      {/* ── Bottom: ETA + route info + end button ── */}
      <div className="nav-hud-bottom">

        <div className="nav-hud-stat">
          <span className="nav-hud-stat-val">{Math.max(0, Math.round(remMin))}</span>
          <span className="nav-hud-stat-lbl">min left</span>
        </div>

        <div className="nav-hud-divider" />

        <div className="nav-hud-stat">
          <span className="nav-hud-stat-val">{fmtDist(remKm)}</span>
          <span className="nav-hud-stat-lbl">remaining</span>
        </div>

        <div className="nav-hud-route-label">
          {arrived
            ? '🎉 Destination reached'
            : route?.distance_km
              ? `${route.distance_km.toFixed(1)} km route`
              : 'Navigating…'}
        </div>

        <button className="nav-hud-end-btn" onClick={onEnd} id="nav-hud-end-btn">
          <span className="material-icons-round">close</span>
          <span>End</span>
        </button>

      </div>
    </div>
  )
}
