import { useEffect, useRef, useState } from 'react'
import { solve, toCampus, type Fix, type GeoCfg, type LiveStatus, type Pt2 } from './geo'
import type { MotionStatus } from './motion'

/** The 📍 pill: what live location is doing right now. Tap to turn it on/off. */
export function LivePill({
  live, status, fix, where, room, onToggle,
}: {
  live: boolean
  status: LiveStatus
  fix: Fix | null
  where: 'in' | 'out' | 'stuck' | null
  room: 'campus' | 'hackgt'
  onToggle: () => void
}) {
  const place = room === 'hackgt' ? 'Klaus' : 'campus'
  const text = !live
    ? 'Live location is off · tap to turn it on'
    : status === 'unavailable'
      ? 'Location needs HTTPS'
      : status === 'denied'
        ? 'Location blocked'
        : status === 'waiting' || !fix
          ? 'Finding you…'
          : fix.acc > 60
            ? `GPS too rough (±${Math.round(fix.acc)} m). Turn on Precise Location + Wi-Fi`
            : where === 'stuck'
              ? 'GPS paused, you steer until it updates'
              : where === 'out'
              ? `Not in ${place}, so you steer`
              : `Live ±${Math.round(fix.acc)} m`
  const on = live && status === 'live' && where === 'in' && !!fix && fix.acc <= 60
  return (
    <button className={on ? 'live-pill on' : 'live-pill'} onClick={onToggle} title={live ? 'Turn live location off and steer yourself' : 'Move your bean with your phone\'s location'}>
      {live ? '📍' : '🧭'} {text}{live ? ' · tap to turn off' : ''}
      {live && fix && <span className="live-raw">{fix.lat.toFixed(6)}, {fix.lon.toFixed(6)}</span>}
    </button>
  )
}

/** Offer (and report) step-and-compass tracking on top of GPS. */
export function MotionPill({ status, wanted, onEnable }: { status: MotionStatus; wanted: boolean; onEnable: () => void }) {
  if (wanted && status === 'on') return <div className="live-pill on">🚶 Steps + compass on: smoother tracking</div>
  if (wanted && status === 'unsupported')
    return <div className="live-pill">🚶 No motion sensors here, using GPS only</div>
  const iOS = /iPhone|iPad/.test(navigator.userAgent)
  return (
    <button className="live-pill" onClick={onEnable}>
      🚶 Tap to use steps + compass (smoother)
      {wanted && status !== 'on' && iOS && <span className="live-raw">Blocked? Settings → Safari → Motion &amp; Orientation Access</span>}
    </button>
  )
}

/**
 * On-site calibration (open the game with ?calibrate): stand at two or more
 * known spots in the atrium, tap each, and paste the result into server/geo.json.
 */
export function Calibrate({
  fix, spots, onApply, onMark,
}: {
  fix: Fix | null
  spots: { name: string; h: Pt2 }[]
  onApply: (cfg: GeoCfg) => void
  onMark?: (label: string) => void
}) {
  const [pairs, setPairs] = useState<{ name: string; c: Pt2; h: Pt2 }[]>([])
  const cfg = solve(pairs)
  // Each mark averages ~10 s of fixes (weighted by accuracy) instead of trusting one
  // noisy reading: roughly 3× less error per spot, so a much tighter alignment.
  const [busy, setBusy] = useState<{ name: string; h: Pt2; until: number } | null>(null)
  const acc = useRef({ sx: 0, sz: 0, w: 0, n: 0 })
  useEffect(() => {
    if (!busy || !fix) return
    const c = toCampus(fix.lat, fix.lon)
    const w = 1 / Math.max(4, fix.acc) ** 2
    acc.current.sx += c[0] * w
    acc.current.sz += c[1] * w
    acc.current.w += w
    acc.current.n++
  }, [fix, busy])
  const [, tick] = useState(0)
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => {
      tick((n) => n + 1)
      if (Date.now() < busy.until) return
      const a = acc.current
      if (a.w > 0) setPairs((p) => [...p.filter((q) => q.name !== busy.name), { name: busy.name, c: [a.sx / a.w, a.sz / a.w], h: busy.h }])
      setBusy(null)
    }, 250)
    return () => clearInterval(t)
  }, [busy])
  return (
    <div className="calibrate">
      <b>Calibrate Klaus</b>
      <div className="cal-fix">{fix ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)} ±${Math.round(fix.acc)} m` : 'waiting for GPS…'}</div>
      <div className="cal-hint">Stand at a spot, tap it, and hold still for 10 s while it averages. Use 3–4 spots spread across the atrium.</div>
      <div className="cal-spots">
        {spots.map((s) => (
          <button
            key={s.name}
            disabled={!fix || !!busy}
            onClick={() => {
              if (!fix) return
              onMark?.(s.name)
              acc.current = { sx: 0, sz: 0, w: 0, n: 0 }
              setBusy({ name: s.name, h: s.h, until: Date.now() + 10000 })
            }}
          >
            {pairs.some((p) => p.name === s.name) ? '✓ ' : ''}
            {s.name}
            {busy?.name === s.name ? ` · hold still ${Math.max(0, Math.ceil((busy.until - Date.now()) / 1000))}s (${acc.current.n} fixes)` : ''}
          </button>
        ))}
      </div>
      {cfg && (
        <>
          <textarea readOnly rows={4} value={JSON.stringify({ ...cfg, note: `calibrated on site from ${pairs.map((p) => p.name).join(', ')}` }, null, 2)} />
          <div className="cal-actions">
            <button onClick={() => onApply(cfg)}>Use on this device</button>
            <span>Paste into server/geo.json to use for everyone.</span>
          </div>
        </>
      )}
    </div>
  )
}
