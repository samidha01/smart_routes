import { useState, useEffect, useRef, useCallback } from 'react'
import {
  TIME_PERIODS,
  getCurrentHour,
  getTimePeriod,
  getSliderLabel,
} from '../services/trafficPenalty'
import './TimeSlider.css'

/**
 * TimeSlider
 * Floating panel that appears over the map (bottom-right, non-overlapping) after
 * routes are generated. Lets the user simulate departure at different hours and
 * see route rankings change dynamically.
 *
 * Props:
 *   visible   {boolean}  — show/hide (only after routes exist)
 *   hour      {number}   — current selected hour (0-23), controlled
 *   onChange  {function} — (newHour) => void
 */
export default function TimeSlider({ visible, hour, onChange }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const sliderRef = useRef(null)

  const periodId = getTimePeriod(hour)
  const period = TIME_PERIODS[periodId]

  // Format hour label for the track ticks
  function tickLabel(h) {
    if (h === 0) return '12a'
    if (h === 12) return '12p'
    if (h < 12) return `${h}a`
    return `${h - 12}p`
  }

  // Keyboard shortcut: ESC to collapse
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') setIsExpanded(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (!visible) return null

  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  const displayAmPm = hour < 12 ? 'AM' : 'PM'

  // Ticks at key hours
  const ticks = [0, 6, 7, 12, 16, 20, 23]

  return (
    <div
      className={`ts-panel ${isExpanded ? 'ts-expanded' : 'ts-collapsed'}`}
      style={{ '--period-color': period.color, '--period-glow': period.glowColor }}
      id="time-slider-panel"
    >
      {/* ── Collapsed pill ── */}
      {!isExpanded && (
        <button
          className="ts-pill"
          id="time-slider-toggle"
          onClick={() => setIsExpanded(true)}
          title="Open Prediction Time slider"
        >
          <span className="ts-pill-emoji">{period.emoji}</span>
          <span className="ts-pill-time">{displayHour}:00 {displayAmPm}</span>
          <span className="ts-pill-period">{period.label}</span>
          <span className="material-icons-round ts-pill-expand">expand_less</span>
        </button>
      )}

      {/* ── Expanded panel ── */}
      {isExpanded && (
        <div className="ts-body">
          {/* Header */}
          <div className="ts-header">
            <div className="ts-header-left">
              <span className="material-icons-round ts-header-icon">schedule</span>
              <div>
                <div className="ts-header-label">Prediction Time</div>
                <div className="ts-header-sub">Simulate departure &amp; re-rank routes</div>
              </div>
            </div>
            <button
              className="ts-close-btn"
              id="time-slider-close"
              onClick={() => setIsExpanded(false)}
              title="Collapse"
            >
              <span className="material-icons-round">expand_more</span>
            </button>
          </div>

          {/* Time display */}
          <div className="ts-time-display">
            <div className="ts-time-clock" style={{ color: period.color }}>
              {displayHour}:00 <span className="ts-ampm">{displayAmPm}</span>
            </div>
            <div className="ts-period-badge" style={{ background: period.glowColor, borderColor: period.color }}>
              <span className="ts-period-emoji">{period.emoji}</span>
              <span className="ts-period-name">{period.label}</span>
            </div>
          </div>

          {/* Description */}
          <div className="ts-description" style={{ color: period.color }}>
            <span className="material-icons-round ts-desc-icon">info_outline</span>
            {period.description} · Routes re-ranked for this time
          </div>

          {/* Slider track */}
          <div className="ts-slider-wrap">
            <input
              ref={sliderRef}
              type="range"
              className="ts-slider"
              id="time-departure-slider"
              min={0}
              max={23}
              step={1}
              value={hour}
              onChange={e => onChange(parseInt(e.target.value, 10))}
              style={{ '--thumb-color': period.color, '--fill-pct': `${(hour / 23) * 100}%` }}
            />
            {/* Tick marks at key hours */}
            <div className="ts-ticks">
              {ticks.map(t => (
                <button
                  key={t}
                  className={`ts-tick ${hour === t ? 'ts-tick-active' : ''}`}
                  style={hour === t ? { color: period.color } : {}}
                  onClick={() => onChange(t)}
                  title={getSliderLabel(t)}
                >
                  {tickLabel(t)}
                </button>
              ))}
            </div>
          </div>

          {/* Period legend */}
          <div className="ts-legend">
            {Object.values(TIME_PERIODS).map(p => (
              <button
                key={p.id}
                className={`ts-legend-item ${periodId === p.id ? 'ts-legend-active' : ''}`}
                style={periodId === p.id ? { borderColor: p.color, color: p.color, background: p.glowColor } : {}}
                onClick={() => onChange(p.hours[0])}
                title={p.description}
              >
                <span className="ts-legend-emoji">{p.emoji}</span>
                <span className="ts-legend-name">{p.label}</span>
              </button>
            ))}
          </div>

          {/* Now button */}
          <button
            className="ts-now-btn"
            id="time-slider-now-btn"
            onClick={() => onChange(getCurrentHour())}
            title="Reset to current local time"
          >
            <span className="material-icons-round">my_location</span>
            Jump to Now
          </button>
        </div>
      )}
    </div>
  )
}
