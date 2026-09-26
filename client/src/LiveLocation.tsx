import { useState } from 'react'
import { solve, toCampus, type Fix, type GeoCfg, type LiveStatus, type Pt2 } from './geo'

/** The 📍 pill: what live location is doing right now. Tap to turn it on/off. */
export function LivePill({
  live, status, fix, where, room, onToggle,
}: {
  live: boolean
  status: LiveStatus
  fix: Fix | null
  where: 'in' | 'out' | null
  room: 'campus' | 'hackgt'
  onToggle: () => void
}) {
  const place = room === 'hackgt' ? 'Klaus' : 'campus'
  const text = !live
    ? 'Beta mode: moving with keys · tap for live GPS'
    : status === 'unavailable'
      ? 'Location needs HTTPS'
      : status === 'denied'
        ? 'Location blocked'
        : status === 'waiting' || !fix
          ? 'Finding you…'
          : fix.acc > 60
            ? `GPS too rough (±${Math.round(fix.acc)} m). Turn on Precise Location + Wi-Fi`
            : where === 'out'
              ? `Not in ${place}, using keys`
              : `Live ±${Math.round(fix.acc)} m`
  const on = live && status === 'live' && where === 'in' && !!fix && fix.acc <= 60
  return (
    <button className={on ? 'live-pill on' : 'live-pill'} onClick={onToggle} title="Beta mode on = keys; off = live GPS">
      {live ? '📍' : '🧪'} {text}{live ? ' · tap for beta mode' : ''}
      {live && fix && <span className="live-raw">{fix.lat.toFixed(6)}, {fix.lon.toFixed(6)}</span>}
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
  return (
    <div className="calibrate">
      <b>Calibrate Klaus</b>
      <div className="cal-fix">{fix ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)} ±${Math.round(fix.acc)} m` : 'waiting for GPS…'}</div>
      <div className="cal-hint">Stand at a spot, wait for ± to settle, then tap it. Two far-apart spots minimum.</div>
      <div className="cal-spots">
        {spots.map((s) => (
          <button
            key={s.name}
            disabled={!fix}
            onClick={() => {
              if (!fix) return
              onMark?.(s.name)
              setPairs((p) => [...p.filter((q) => q.name !== s.name), { name: s.name, c: toCampus(fix.lat, fix.lon), h: s.h }])
            }}
          >
            {pairs.some((p) => p.name === s.name) ? '✓ ' : ''}
            {s.name}
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
