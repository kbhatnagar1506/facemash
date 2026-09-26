import { useEffect, useState } from 'react'

// Real-world positioning. GPS (lat/lon) → campus metres uses the same projection
// scripts/build_map.py used to build the map, so campus positions are direct.
// Campus → Klaus atrium is a similarity transform (rotate + scale + shift),
// served by the Go server from server/geo.json and fixed on site with ?calibrate.

const LAT0 = 33.776
const LON0 = -84.398
const M_PER_LAT = 110_540
const M_PER_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180)

export type Pt2 = [number, number]

/** Campus metres (+x east, +z south) for a GPS fix. */
export function toCampus(lat: number, lon: number): Pt2 {
  return [(lon - LON0) * M_PER_LON, -(lat - LAT0) * M_PER_LAT]
}

/** hall = (a + i·b)·campus + (tx + i·tz), treating (x, z) as a complex number. */
export interface GeoCfg {
  a: number
  b: number
  tx: number
  tz: number
}

export function toHall(cfg: GeoCfg, lat: number, lon: number): Pt2 {
  const [cx, cz] = toCampus(lat, lon)
  return [cfg.a * cx - cfg.b * cz + cfg.tx, cfg.b * cx + cfg.a * cz + cfg.tz]
}

/**
 * Best-fit rotate+scale+shift from ≥2 (campus, hall) point pairs: stand at known
 * spots in the atrium, record the GPS there, and this lines the room up with reality.
 */
export function solve(pairs: { c: Pt2; h: Pt2 }[]): GeoCfg | null {
  if (pairs.length < 2) return null
  const n = pairs.length
  const mc = pairs.reduce((m, p) => [m[0] + p.c[0] / n, m[1] + p.c[1] / n], [0, 0])
  const mh = pairs.reduce((m, p) => [m[0] + p.h[0] / n, m[1] + p.h[1] / n], [0, 0])
  let num1 = 0
  let num2 = 0
  let den = 0
  for (const { c, h } of pairs) {
    const cx = c[0] - mc[0]
    const cz = c[1] - mc[1]
    const hx = h[0] - mh[0]
    const hz = h[1] - mh[1]
    num1 += cx * hx + cz * hz
    num2 += cx * hz - cz * hx
    den += cx * cx + cz * cz
  }
  if (den < 1e-6) return null
  const a = num1 / den
  const b = num2 / den
  return { a, b, tx: mh[0] - (a * mc[0] - b * mc[1]), tz: mh[1] - (b * mc[0] + a * mc[1]) }
}

export interface Fix {
  lat: number
  lon: number
  acc: number
  at: number
  /** when the reported position last actually changed (frozen fixes keep an old value) */
  since?: number
}

export type LiveStatus = 'off' | 'waiting' | 'live' | 'denied' | 'unavailable'

/** Watches the device's position while `enabled`. Needs HTTPS (or localhost). */
export function useLiveLocation(enabled: boolean) {
  const [fix, setFix] = useState<Fix | null>(null)
  const [status, setStatus] = useState<LiveStatus>('off')
  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      setFix(null)
      return
    }
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      setStatus('unavailable')
      return
    }
    setStatus('waiting')
    // iOS sometimes keeps replaying one cached position (seen on-site: the same coords
    // 15× over 80 s). Ask for fresh fixes only, and if the position hasn't changed for
    // 12 s, restart the watch to kick the location service awake.
    let id = 0
    let lastKey = ''
    let lastChange = Date.now()
    const start = () =>
      navigator.geolocation.watchPosition(
        (p) => {
          setStatus('live')
          const key = `${p.coords.latitude},${p.coords.longitude}`
          if (key !== lastKey) {
            lastKey = key
            lastChange = Date.now()
          }
          setFix({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now(), since: lastChange })
        },
        (e) => setStatus(e.code === e.PERMISSION_DENIED ? 'denied' : 'waiting'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      )
    id = start()
    const kick = setInterval(() => {
      if (Date.now() - lastChange > 12000) {
        navigator.geolocation.clearWatch(id)
        id = start()
        lastChange = Date.now() - 6000 // give the restart a few seconds before kicking again
      }
    }, 3000)
    return () => {
      clearInterval(kick)
      navigator.geolocation.clearWatch(id)
    }
  }, [enabled])
  return { fix, status }
}
