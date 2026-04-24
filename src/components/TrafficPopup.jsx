import { useEffect, useRef } from 'react'
import './TrafficPopup.css'

// ── Known Mumbai peak windows ─────────────────────────────────────────────────
const PEAK_WINDOWS = [
  { label: '7–10 AM', startH: 7,  endH: 10, level: 'high',   delay: '15–25 min' },
  { label: '5–9 PM',  startH: 17, endH: 21, level: 'high',   delay: '20–35 min' },
  { label: '12–2 PM', startH: 12, endH: 14, level: 'medium', delay: '8–15 min'  },
]

// Known congestion corridors by rough lat/lon midpoint area
const CORRIDORS = [
  { name: 'Ghodbunder Road',       minLat: 19.20, maxLat: 19.30, minLon: 72.95, maxLon: 73.05 },
  { name: 'Eastern Express Highway',minLat: 19.05, maxLat: 19.20, minLon: 72.88, maxLon: 72.96 },
  { name: 'Western Express Highway',minLat: 19.10, maxLat: 19.35, minLon: 72.82, maxLon: 72.88 },
  { name: 'Thane–Belapur Road',     minLat: 19.00, maxLat: 19.15, minLon: 73.00, maxLon: 73.12 },
  { name: 'NH-48 Mumbai–Pune',      minLat: 18.90, maxLat: 19.10, minLon: 73.05, maxLon: 73.20 },
  { name: 'Kalyan–Shilphata Road',  minLat: 19.18, maxLat: 19.28, minLon: 73.12, maxLon: 73.22 },
  { name: 'Badlapur–Ambernath Road',minLat: 19.13, maxLat: 19.20, minLon: 73.18, maxLon: 73.28 },
]

/**
 * Analyse traffic for a route using time + geometry.
 * Returns null if no significant congestion found.
 */
export function analyseTraffic(route) {
  const hour = new Date().getHours()

  // Find active peak window
  const peak = PEAK_WINDOWS.find(w => hour >= w.startH && hour < w.endH)
  if (!peak) return null   // off-peak — no popup needed

  // Find which corridor the route passes through (using midpoint of geometry)
  const path = route?.path_geometry || route?.path || []
  let corridor = null

  if (path.length > 0) {
    // Sample a few points along the path
    const samples = [
      path[Math.floor(path.length * 0.25)],
      path[Math.floor(path.length * 0.50)],
      path[Math.floor(path.length * 0.75)],
    ].filter(Boolean)

    for (const pt of samples) {
      const [lon, lat] = pt
      corridor = CORRIDORS.find(c =>
        lat >= c.minLat && lat <= c.maxLat &&
        lon >= c.minLon && lon <= c.maxLon
      )
      if (corridor) break
    }
  }

  // Fallback corridor name from distance
  const segmentName = corridor?.name ||
    (route?.distance_km > 30 ? 'Highway corridor' : 'Urban arterial road')

  return {
    level:   peak.level,                  // 'high' | 'medium'
    window:  peak.label,                  // '7–10 AM'
    delay:   peak.delay,                  // '15–25 min'
    segment: segmentName,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TrafficPopup({ traffic, rank, totalRoutes, onSwitch, onDismiss }) {
  const timerRef = useRef(null)

  // Auto-dismiss after 9 seconds
  useEffect(() => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(onDismiss, 9000)
    return () => clearTimeout(timerRef.current)
  }, [traffic, onDismiss])

  if (!traffic) return null

  const isHigh    = traffic.level === 'high'
  const canSwitch = rank > 1   // there's a better route above this one

  return (
    <div className={`tp-popup tp-popup-${traffic.level}`} role="alert">

      {/* Icon + headline */}
      <div className="tp-top">
        <span className="material-icons-round tp-icon">
          {isHigh ? 'traffic' : 'warning_amber'}
        </span>

        <div className="tp-text">
          <span className="tp-title">
            {isHigh ? 'Heavy traffic on this route' : 'Moderate congestion ahead'}
          </span>
          <span className="tp-meta">
            <strong>{traffic.segment}</strong>
            &nbsp;·&nbsp;{traffic.window}
            &nbsp;·&nbsp;+{traffic.delay} delay
          </span>
        </div>

        <button className="tp-close" onClick={onDismiss} title="Dismiss" aria-label="Close">
          <span className="material-icons-round">close</span>
        </button>
      </div>

      {/* Actions */}
      <div className="tp-actions">
        {canSwitch && (
          <button className="tp-btn tp-btn-switch" onClick={onSwitch}>
            <span className="material-icons-round">alt_route</span>
            Switch to Route #{rank - 1}
          </button>
        )}
        <button className="tp-btn tp-btn-continue" onClick={onDismiss}>
          <span className="material-icons-round">arrow_forward</span>
          Continue anyway
        </button>
      </div>

      {/* Progress bar auto-dismiss indicator */}
      <div className="tp-timer-bar" />
    </div>
  )
}
