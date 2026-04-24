import { useState, useEffect, useRef } from 'react'
import { fetchVehiclesByType, fetchAutocomplete } from '../services/api'
import './ControlPanel.css'

// ── Reverse-geocode a lat/lon to a human-readable name via Nominatim ──────────
async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`,
      { headers: { 'Accept-Language': 'en' } }
    )
    const data = await res.json()
    // Build a short readable label: suburb / town / city
    const a = data.address || {}
    const name =
      a.suburb || a.neighbourhood || a.quarter ||
      a.town || a.city_district || a.village ||
      a.city || a.county || data.display_name?.split(',')[0] ||
      'My Location'
    return { name, lat: parseFloat(data.lat), lon: parseFloat(data.lon) }
  } catch (_) {
    return { name: 'My Location', lat, lon }
  }
}

const VEHICLE_TYPES = ['car', 'bike', 'truck', 'tempo']
const FUEL_TYPES = ['petrol', 'diesel', 'electric', 'cng', 'hybrid']
const MODES = [
  { value: 'fastest', label: 'Fastest', icon: 'bolt', desc: 'Minimize travel time' },
  { value: 'eco', label: 'Eco', icon: 'eco', desc: 'Minimize fuel usage' },
]
const VTYPE_ICONS = {
  car: 'directions_car', bike: 'two_wheeler', truck: 'local_shipping', tempo: 'airport_shuttle',
}
const MAX_STOPS = 5

// ── Geocode-backed Autocomplete Input ─────────────────────────────────────────

function GeoInput({ id, label, icon, value, onChange, onSelectLocation, error, placeholder, gpsState, onGpsClick }) {
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!value || value.length < 3) { setSuggestions([]); return }

    let active = true
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetchAutocomplete(value)
        if (active) setSuggestions(res.results || [])
      } catch (err) {
        console.error('Autocomplete error', err)
      } finally {
        if (active) setLoading(false)
      }
    }, 450)

    return () => { active = false }
  }, [value])

  function handleSelect(item) {
    const displayText = item.short_name || item.name?.split(',')[0] || item.name
    onChange(displayText)
    if (onSelectLocation) onSelectLocation(item)
    setSuggestions([])
  }

  return (
    <div className="cp-field">
      <div className="cp-label-row">
        <label className="cp-label" htmlFor={id}>
          <span className="material-icons-round">{icon}</span>{label}
        </label>
        {onGpsClick && (
          <button
            type="button"
            id={`${id}-gps-btn`}
            className={`cp-gps-btn cp-gps-btn-${gpsState || 'idle'}`}
            onClick={onGpsClick}
            disabled={gpsState === 'loading'}
            title="Use my current GPS location"
          >
            {gpsState === 'loading' ? (
              <span className="cp-spinner-sm" />
            ) : gpsState === 'success' ? (
              <span className="material-icons-round">my_location</span>
            ) : gpsState === 'error' ? (
              <span className="material-icons-round">location_disabled</span>
            ) : (
              <span className="material-icons-round">my_location</span>
            )}
            <span>
              {gpsState === 'loading' ? 'Locating…'
                : gpsState === 'success' ? 'Located ✓'
                  : gpsState === 'error' ? 'GPS Failed'
                    : 'My Location'}
            </span>
          </button>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <input
          id={id}
          className={`cp-input${error ? ' cp-input-error' : ''}${gpsState === 'success' ? ' cp-input-gps-success' : ''}`}
          placeholder={placeholder || 'Search any location…'}
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={() => setTimeout(() => setSuggestions([]), 220)}
          autoComplete="off"
        />
        {gpsState === 'success' && (
          <span className="cp-gps-pin-icon">
            <span className="material-icons-round">gps_fixed</span>
          </span>
        )}
        {loading && !gpsState && (
          <span className="cp-input-loading">
            <span className="cp-spinner-sm" />
          </span>
        )}
        {suggestions.length > 0 && (
          <ul className="cp-suggestions">
            {suggestions.map((item, idx) => (
              <li key={idx} onMouseDown={() => handleSelect(item)}>
                <span className="material-icons-round">place</span>
                <span className="cp-suggestion-main">{item.short_name || item.name?.split(',')[0]}</span>
                <span className="cp-suggestion-sub">{item.name?.split(',').slice(1, 3).join(',')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <span className="cp-error">{error}</span>}
    </div>
  )
}

// ── Main Control Panel ────────────────────────────────────────────────────────

export default function ControlPanel({ onSubmit, loading }) {
  const [form, setForm] = useState({
    source: '', destination: '',
    source_lat: null, source_lon: null,
    dest_lat: null, dest_lon: null,
    vehicle_type: 'car', vehicle_brand: '',
    vehicle_model: '', mileage: '', fuel_type: 'petrol', mode: 'fastest',
  })
  const [fuelLevel,        setFuelLevel]        = useState(75)  // 0-100%
  const [optimizeStops,    setOptimizeStops]    = useState(false)
  const [priorityStops,    setPriorityStops]    = useState([])  // [{ label, lat, lon }]
  const [stopInput,        setStopInput]        = useState('')
  const [stopSuggestions,  setStopSuggestions]  = useState([])
  const [stopLoading,      setStopLoading]      = useState(false)
  const [brands,           setBrands]           = useState([])
  const [models,           setModels]           = useState([])
  const [errors,           setErrors]           = useState({})
  const [gpsState,         setGpsState]         = useState('idle')   // idle | loading | success | error
  const stopDebounceRef = useRef(null)
  const gpsResetTimer = useRef(null)

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }))
    setErrors(e => ({ ...e, [key]: null }))
  }

  // ── GPS "Use My Location" ────────────────────────────────────────────────────
  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      setGpsState('error')
      setErrors(e => ({ ...e, source: 'GPS not supported by your browser' }))
      return
    }
    setGpsState('loading')
    clearTimeout(gpsResetTimer.current)

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        const { name } = await reverseGeocode(latitude, longitude)
        setForm(f => ({
          ...f,
          source: name,
          source_lat: latitude,
          source_lon: longitude,
        }))
        setErrors(e => ({ ...e, source: null }))
        setGpsState('success')
        // Reset badge after 4s so the user knows they can re-tap
        gpsResetTimer.current = setTimeout(() => setGpsState('idle'), 4000)
      },
      (err) => {
        console.warn('[GPS] Error:', err.message)
        setGpsState('error')
        const msg = err.code === 1
          ? 'Location access denied — allow it in browser settings'
          : err.code === 2
            ? 'Location unavailable right now'
            : 'GPS timed out — try again'
        setErrors(e => ({ ...e, source: msg }))
        gpsResetTimer.current = setTimeout(() => setGpsState('idle'), 4000)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    )
  }

  // Fetch vehicle brands on type change
  useEffect(() => {
    fetchVehiclesByType(form.vehicle_type)
      .then(data => { setBrands(Object.keys(data)); setModels([]) })
      .catch(() => setBrands([]))
  }, [form.vehicle_type])

  useEffect(() => {
    if (!form.vehicle_brand) { setModels([]); return }
    fetchVehiclesByType(form.vehicle_type)
      .then(data => setModels(Object.keys(data[form.vehicle_brand] || {})))
      .catch(() => setModels([]))
  }, [form.vehicle_brand, form.vehicle_type])

  useEffect(() => {
    if (!form.vehicle_brand || !form.vehicle_model) return
    fetchVehiclesByType(form.vehicle_type).then(data => {
      const md = data?.[form.vehicle_brand]?.[form.vehicle_model]
      if (md) setForm(f => ({ ...f, mileage: md.mileage ?? f.mileage, fuel_type: md.fuel_type ?? f.fuel_type }))
    }).catch(() => { })
  }, [form.vehicle_model])

  // Priority stop autocomplete
  useEffect(() => {
    if (stopDebounceRef.current) clearTimeout(stopDebounceRef.current)
    if (!stopInput || stopInput.length < 3) { setStopSuggestions([]); return }

    let active = true
    stopDebounceRef.current = setTimeout(async () => {
      setStopLoading(true)
      try {
        const res = await fetchAutocomplete(stopInput)
        if (active) setStopSuggestions(res.results || [])
      } catch (_) { }
      finally { if (active) setStopLoading(false) }
    }, 450)

    return () => { active = false }
  }, [stopInput])

  function addStop(item) {
    if (priorityStops.length >= MAX_STOPS) {
      setErrors(e => ({ ...e, stop: `Max ${MAX_STOPS} stops allowed` }))
      return
    }
    const label = item
      ? (item.short_name || item.name?.split(',')[0] || item.name)
      : stopInput.trim()

    if (!label) { setErrors(e => ({ ...e, stop: 'Enter a location' })); return }

    // Deduplicate
    if (priorityStops.some(s => s.label.toLowerCase() === label.toLowerCase())) {
      setErrors(e => ({ ...e, stop: 'Already added' })); return
    }

    const newStop = {
      label,
      lat: item?.lat ?? null,
      lon: item?.lon ?? null,
    }
    setPriorityStops(p => [...p, newStop])
    setStopInput('')
    setStopSuggestions([])
    setErrors(e => ({ ...e, stop: null }))
  }

  function removeStop(idx) {
    setPriorityStops(p => p.filter((_, i) => i !== idx))
  }

  function validate() {
    const e = {}
    if (!form.source) e.source = 'Required'
    if (!form.destination) e.destination = 'Required'
    if (form.source && form.destination && form.source.toLowerCase() === form.destination.toLowerCase())
      e.destination = 'Must differ from source'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSubmit(e) {
    e.preventDefault()
    if (!validate() || loading) return

    onSubmit({
      ...form,
      priority_stops: priorityStops,
      fuel_level: fuelLevel,
      optimize_stops: optimizeStops,
    })
  }

  return (
    <form className="control-panel" onSubmit={handleSubmit} noValidate>
      <div className="cp-header">
        <span className="material-icons-round cp-header-icon">tune</span>
        <div>
          <h2 className="cp-title">Route Planner</h2>
          <p className="cp-subtitle">AI-powered optimization · Full MMR coverage</p>
        </div>
      </div>

      {/* ── Journey ── */}
      <div className="cp-section">
        <p className="cp-section-label">Journey</p>
        <GeoInput
          id="cp-source"
          label="Source"
          icon="trip_origin"
          value={form.source}
          placeholder="e.g. Badlapur West, Dadar Station…"
          onChange={v => {
            set('source', v)
            // If user manually edits after GPS fill, clear GPS state
            if (gpsState === 'success') setGpsState('idle')
          }}
          onSelectLocation={item => setForm(f => ({
            ...f,
            source: item.short_name || item.name?.split(',')[0] || item.name,
            source_lat: item.lat,
            source_lon: item.lon,
          }))}
          error={errors.source}
          gpsState={gpsState}
          onGpsClick={handleUseMyLocation}
        />

        <div className="cp-swap-row">
          <button type="button" className="cp-swap-btn" id="cp-swap-btn"
            onClick={() => setForm(f => ({
              ...f,
              source: f.destination, destination: f.source,
              source_lat: f.dest_lat, source_lon: f.dest_lon,
              dest_lat: f.source_lat, dest_lon: f.source_lon,
            }))}>
            <span className="material-icons-round">swap_vert</span>
            <span>Swap</span>
          </button>
        </div>

        <GeoInput
          id="cp-destination"
          label="Destination"
          icon="place"
          value={form.destination}
          placeholder="e.g. Karjat, Panvel, Vashi…"
          onChange={v => set('destination', v)}
          onSelectLocation={item => setForm(f => ({
            ...f,
            destination: item.short_name || item.name?.split(',')[0] || item.name,
            dest_lat: item.lat,
            dest_lon: item.lon,
          }))}
          error={errors.destination}
        />
      </div>

      {/* ── Priority Stops ── */}
      <div className="cp-section">
        <p className="cp-section-label">
          Priority Stops
          <span className="cp-optional"> (optional · max {MAX_STOPS})</span>
        </p>
        <div className="cp-stop-row">
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              id="cp-stop-input"
              className="cp-input"
              placeholder="Add a must-visit stop…"
              value={stopInput}
              onChange={e => setStopInput(e.target.value)}
              onBlur={() => setTimeout(() => setStopSuggestions([]), 200)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addStop())}
              autoComplete="off"
              disabled={priorityStops.length >= MAX_STOPS}
            />
            {stopLoading && (
              <span className="cp-input-loading"><span className="cp-spinner-sm" /></span>
            )}
            {stopSuggestions.length > 0 && (
              <ul className="cp-suggestions">
                {stopSuggestions.map((item, idx) => (
                  <li key={idx} onMouseDown={() => addStop(item)}>
                    <span className="material-icons-round">push_pin</span>
                    <span className="cp-suggestion-main">{item.short_name || item.name?.split(',')[0]}</span>
                    <span className="cp-suggestion-sub">{item.name?.split(',').slice(1, 3).join(',')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            className="cp-add-stop-btn"
            id="cp-add-stop"
            onClick={() => addStop()}
            disabled={priorityStops.length >= MAX_STOPS}
          >
            <span className="material-icons-round">add</span>
          </button>
        </div>
        {errors.stop && <span className="cp-error">{errors.stop}</span>}
        {priorityStops.length > 0 && (
          <div className="cp-stop-chips">
            {priorityStops.map((s, i) => (
              <span key={i} className="cp-stop-chip">
                <span className="material-icons-round" style={{ fontSize: 12 }}>push_pin</span>
                {s.label}
                <button
                  type="button"
                  className="cp-stop-chip-remove"
                  onClick={() => removeStop(i)}
                >
                  <span className="material-icons-round" style={{ fontSize: 12 }}>close</span>
                </button>
              </span>
            ))}
          </div>
        )}

        {priorityStops.length > 1 && (
          <div className="cp-field" style={{ marginTop: 12 }}>
            <label className="cp-label cp-checkbox-label">
              <input
                type="checkbox"
                checked={optimizeStops}
                onChange={e => setOptimizeStops(e.target.checked)}
              />
              Auto-Optimize Stop Order (TSP Algorithm)
            </label>
            <p className="cp-optional" style={{ marginLeft: 24, marginTop: 4, display: 'block' }}>
              We'll calculate the absolute fastest sequence to visit all stops.
            </p>
          </div>
        )}
      </div>

      {/* ── Vehicle ── */}
      <div className="cp-section">
        <p className="cp-section-label">Vehicle</p>
        <div className="cp-vehicle-type-row">
          {VEHICLE_TYPES.map(t => (
            <button key={t} type="button" id={`cp-vtype-${t}`}
              className={`cp-vtype-btn${form.vehicle_type === t ? ' active' : ''}`}
              onClick={() => set('vehicle_type', t)}>
              <span className="material-icons-round">{VTYPE_ICONS[t]}</span>
              <span>{t.charAt(0).toUpperCase() + t.slice(1)}</span>
            </button>
          ))}
        </div>
        <div className="cp-row-2">
          <div className="cp-field">
            <label className="cp-label" htmlFor="cp-brand">Brand</label>
            <select id="cp-brand" className="cp-select" value={form.vehicle_brand}
              onChange={e => set('vehicle_brand', e.target.value)}>
              <option value="">— Any —</option>
              {brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="cp-field">
            <label className="cp-label" htmlFor="cp-model">Model</label>
            <select id="cp-model" className="cp-select" value={form.vehicle_model}
              onChange={e => set('vehicle_model', e.target.value)} disabled={!form.vehicle_brand}>
              <option value="">— Any —</option>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="cp-row-2">
          <div className="cp-field">
            <label className="cp-label" htmlFor="cp-mileage">Mileage <span className="cp-optional">km/L</span></label>
            <input id="cp-mileage" className="cp-input" type="number" min="1" max="200" step="0.5"
              placeholder="Auto-fill" value={form.mileage}
              onChange={e => set('mileage', e.target.value)} />
          </div>
          <div className="cp-field">
            <label className="cp-label" htmlFor="cp-fuel">Fuel</label>
            <select id="cp-fuel" className="cp-select" value={form.fuel_type}
              onChange={e => set('fuel_type', e.target.value)}>
              {FUEL_TYPES.map(f => (
                <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Fuel Level Slider ── */}
      <div className="cp-section">
        <p className="cp-section-label">
          Fuel Level
          <span className={`cp-fuel-badge ${fuelLevel <= 20 ? 'cp-fuel-badge-red'
              : fuelLevel <= 45 ? 'cp-fuel-badge-yellow'
                : 'cp-fuel-badge-green'
            }`}>{fuelLevel}%</span>
        </p>
        <div className="cp-fuel-slider-wrap">
          <input
            type="range"
            id="cp-fuel-level"
            min="0"
            max="100"
            step="5"
            value={fuelLevel}
            onChange={e => setFuelLevel(Number(e.target.value))}
            className={`cp-fuel-slider ${fuelLevel <= 20 ? 'cp-fuel-slider-red'
                : fuelLevel <= 45 ? 'cp-fuel-slider-yellow'
                  : 'cp-fuel-slider-green'
              }`}
          />
          <div className="cp-fuel-track-labels">
            <span>Empty</span>
            <span>Quarter</span>
            <span>Half</span>
            <span>Full</span>
          </div>
          <div className="cp-fuel-bar">
            <div
              className={`cp-fuel-bar-fill ${fuelLevel <= 20 ? 'red' : fuelLevel <= 45 ? 'yellow' : 'green'
                }`}
              style={{ width: `${fuelLevel}%` }}
            />
          </div>
        </div>
        {fuelLevel <= 20 && (
          <div className="cp-fuel-warning">
            <span className="material-icons-round">local_gas_station</span>
            Critical — fuel stations shown on map
          </div>
        )}
        {fuelLevel > 20 && fuelLevel <= 45 && (
          <div className="cp-fuel-caution">
            <span className="material-icons-round">warning</span>
            Low fuel — consider refuelling soon
          </div>
        )}
      </div>

      {/* ── Mode ── */}
      <div className="cp-section">
        <p className="cp-section-label">Optimization Mode</p>
        <div className="cp-mode-row">
          {MODES.map(m => (
            <button key={m.value} type="button" id={`cp-mode-${m.value}`}
              className={`cp-mode-btn${form.mode === m.value ? ' active' : ''}`}
              onClick={() => set('mode', m.value)}>
              <span className="material-icons-round">{m.icon}</span>
              <div>
                <strong>{m.label}</strong>
                <p>{m.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      <button
        type="submit"
        id="cp-generate-btn"
        className={`cp-submit${loading ? ' loading' : ''}`}
        disabled={loading}
      >
        {loading ? (
          <><span className="cp-spinner" /><span>AI Computing Routes…</span></>
        ) : (
          <><span className="material-icons-round">psychology</span><span>Generate AI Routes</span></>
        )}
      </button>
    </form>
  )
}
