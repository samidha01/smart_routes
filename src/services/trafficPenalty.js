/**
 * trafficPenalty.js
 * Lightweight, zero-API time-based traffic scoring adjustment.
 *
 * Determines time period from a given hour (0-23), then applies
 * a penalty multiplier to route scores based on road type heuristics
 * embedded in OSRM route distance/duration ratios.
 *
 * final_score = base_score * (1 + traffic_penalty)
 * Lower is always better.
 */

// ── Time Period Definitions ────────────────────────────────────────────────────

export const TIME_PERIODS = {
  MORNING: {
    id: 'MORNING',
    label: 'Morning Rush',
    emoji: '🌅',
    hours: [7, 8, 9, 10],            // 7 AM – 11 AM
    description: 'Office hours traffic',
    color: '#f59e42',
    glowColor: 'rgba(245, 158, 66, 0.35)',
  },
  AFTERNOON: {
    id: 'AFTERNOON',
    label: 'Afternoon',
    emoji: '☀️',
    hours: [11, 12, 13, 14, 15],     // 11 AM – 4 PM (was 12-4, extended to include 11)
    description: 'Baseline traffic',
    color: '#22d472',
    glowColor: 'rgba(34, 212, 114, 0.35)',
  },
  EVENING: {
    id: 'EVENING',
    label: 'Evening Rush',
    emoji: '🌆',
    hours: [16, 17, 18, 19, 20],     // 4 PM – 9 PM
    description: 'Peak congestion',
    color: '#ff4f6d',
    glowColor: 'rgba(255, 79, 109, 0.35)',
  },
  NIGHT: {
    id: 'NIGHT',
    label: 'Night',
    emoji: '🌙',
    hours: [21, 22, 23, 0, 1, 2, 3, 4, 5, 6],  // 9 PM – 7 AM
    description: 'Minimal traffic',
    color: '#4a9ef5',
    glowColor: 'rgba(74, 158, 245, 0.35)',
  },
}

/**
 * Get the current local hour (0-23) from current time.
 */
export function getCurrentHour() {
  return new Date().getHours()
}

/**
 * Detect time period from a given hour (0-23).
 * @param {number} hour
 * @returns {string} period id: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT'
 */
export function getTimePeriod(hour) {
  const h = Math.floor(hour) % 24
  for (const [id, period] of Object.entries(TIME_PERIODS)) {
    if (period.hours.includes(h)) return id
  }
  return 'AFTERNOON' // fallback
}

/**
 * Heuristically classify a route as highway-heavy or side-road-heavy.
 * Uses the speed ratio: avg_speed = distance / duration
 * - High avg speed (>50 km/h) → likely highway/expressway
 * - Low avg speed (<25 km/h) → likely internal/side roads
 * - Middle → arterial roads
 *
 * @param {object} route — route object with distance_km, estimated_time_min
 * @returns {'highway' | 'arterial' | 'internal'}
 */
function classifyRoadType(route) {
  const distKm = route.distance_km || 0
  const timMin = route.estimated_time_min || route.base_time_min || 1
  if (distKm <= 0 || timMin <= 0) return 'arterial'

  const avgSpeedKmH = (distKm / timMin) * 60

  if (avgSpeedKmH >= 55) return 'highway'
  if (avgSpeedKmH <= 28) return 'internal'
  return 'arterial'
}

/**
 * Traffic penalty table per (period, road_type).
 * Value is added to the normalized composite score.
 * Since composite_score ∈ [0,1] and lower = better,
 * positive penalty = makes route look worse.
 *
 * Calibrated so that:
 * - Rush hour + highway = heavily penalized
 * - Night + highway = preferred (negative penalty = bonus)
 * - Internal roads in rush = only mildly penalized
 */
const PENALTY_TABLE = {
  MORNING: {
    highway:  0.22,   // High — office commuters flood expressways
    arterial: 0.12,   // Moderate
    internal: 0.05,   // Low — side roads still move
  },
  AFTERNOON: {
    highway:  0.0,    // Baseline — no adjustment
    arterial: 0.0,
    internal: 0.0,
  },
  EVENING: {
    highway:  0.28,   // Highest — evening rush is worst
    arterial: 0.15,   // Moderate
    internal: 0.04,   // Internal roads are preferred
  },
  NIGHT: {
    highway: -0.10,   // Bonus — fast, empty highways
    arterial: -0.04,
    internal:  0.02,  // Slight penalty — less lit, slower
  },
}

/**
 * Apply time-based traffic penalties to a list of routes.
 * Returns a NEW array of routes with adjusted `composite_score` and re-ranked.
 *
 * @param {Array} routes — flat list of route objects (with composite_score)
 * @param {string} periodId — 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT'
 * @returns {Array} re-ranked routes with `time_adjusted_score` added
 */
export function applyTrafficPenalty(routes, periodId) {
  if (!routes || routes.length === 0) return routes

  const penalties = PENALTY_TABLE[periodId] || PENALTY_TABLE.AFTERNOON

  // Compute adjusted scores
  const adjusted = routes.map(route => {
    const roadType = classifyRoadType(route)
    const penalty = penalties[roadType] ?? 0
    const baseScore = route.composite_score ?? 0
    // Clamp to [0, 1] after applying penalty
    const adjustedScore = Math.max(0, Math.min(1, baseScore + penalty))

    return {
      ...route,
      time_adjusted_score: adjustedScore,
      traffic_road_type: roadType,
      traffic_penalty_applied: penalty,
    }
  })

  // Sort by adjusted score (lower = better)
  adjusted.sort((a, b) => a.time_adjusted_score - b.time_adjusted_score)

  // Re-assign ranks
  return adjusted.map((r, i) => ({ ...r, rank: i + 1 }))
}

/**
 * Get the slider label for a given hour.
 * @param {number} hour  0-23
 * @returns {string}
 */
export function getSliderLabel(hour) {
  const period = getTimePeriod(hour)
  const p = TIME_PERIODS[period]
  // Format hour as 12h clock
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  const ampm = hour < 12 ? 'AM' : 'PM'
  return `${h12}:00 ${ampm} · ${p.emoji} ${p.label}`
}
