/**
 * api.js  –  SmartFlow AI Routing API Service
 * All calls go through the Vite proxy at /api → http://127.0.0.1:8000
 */

const BASE = '/api'
const WS_BASE = (typeof window !== 'undefined')
  ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
  : 'ws://127.0.0.1:8000/ws'

async function handleResponse(res) {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const err = await res.json()
      if (err.detail && typeof err.detail === 'object') {
        msg = err.detail.error || JSON.stringify(err.detail)
      } else {
        msg = err.detail || err.message || msg
      }
    } catch (_) {}
    throw new Error(msg)
  }
  return res.json()
}

/** POST /optimize-route */
export async function optimizeRoute(params) {
  const body = {
    source:         params.source,
    destination:    params.destination,
    vehicle_type:   params.vehicle_type || 'car',
    vehicle_brand:  params.vehicle_brand || null,
    vehicle_model:  params.vehicle_model || null,
    mileage:        params.mileage ? parseFloat(params.mileage) : null,
    fuel_type:      params.fuel_type || null,
    priority_stops: params.priority_stops || [],
    mode:           params.mode || 'fastest',
    top_k:          50,
    source_lat:     params.source_lat,
    source_lon:     params.source_lon,
    dest_lat:       params.dest_lat,
    dest_lon:       params.dest_lon,
  }
  const res = await fetch(`${BASE}/optimize-route`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  return handleResponse(res)
}

/** GET /routes/autocomplete */
export async function fetchAutocomplete(query) {
  const res = await fetch(`${BASE}/routes/autocomplete?q=${encodeURIComponent(query)}`)
  return handleResponse(res)
}

/** GET /routes/nodes */
export async function fetchNodes() {
  const res = await fetch(`${BASE}/routes/nodes`)
  return handleResponse(res)
}

/** GET /routes/vehicles */
export async function fetchVehicles() {
  const res = await fetch(`${BASE}/routes/vehicles`)
  return handleResponse(res)
}

/** GET /routes/vehicles/:type */
export async function fetchVehiclesByType(type) {
  const res = await fetch(`${BASE}/routes/vehicles/${type}`)
  return handleResponse(res)
}

/** GET /routes/traffic-snapshot */
export async function fetchTrafficSnapshot() {
  const res = await fetch(`${BASE}/routes/traffic-snapshot`)
  return handleResponse(res)
}

/** GET /routes/weather-snapshot */
export async function fetchWeatherSnapshot() {
  const res = await fetch(`${BASE}/routes/weather-snapshot`)
  return handleResponse(res)
}

/** GET /routes/model-metrics */
export async function fetchModelMetrics() {
  const res = await fetch(`${BASE}/routes/model-metrics`)
  return handleResponse(res)
}

/** GET /health */
export async function fetchHealth() {
  const res = await fetch(`${BASE}/health`)
  return handleResponse(res)
}

/**
 * Open a WebSocket for real-time rerouting.
 * @param {string} sessionId
 * @param {function} onMessage  – called with parsed JSON event
 * @returns {{ close: function }} handle to close the WS
 */
export function openRerouteSocket(sessionId, onMessage) {
  const url = `${WS_BASE}/reroute/${sessionId}`
  const ws = new WebSocket(url)

  ws.onopen = () => {
    console.log('[WS] connected – session', sessionId)
  }

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      onMessage(data)
    } catch (_) {}
  }

  ws.onerror = (e) => {
    console.warn('[WS] error', e)
  }

  ws.onclose = () => {
    console.log('[WS] closed – session', sessionId)
  }

  // Send periodic ping
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('ping')
  }, 20000)

  return {
    close: () => {
      clearInterval(pingInterval)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.send('close')
        ws.close()
      }
    },
  }
}
