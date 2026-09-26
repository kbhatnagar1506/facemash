import { useState } from 'react'
import { requestLocation } from './geo'
import { requestMotion } from './motion'

// Arriving on a phone: one tap asks for everything live play uses (location, and motion +
// compass for steps), up front, while the campus and the hall load underneath. Either
// answer is remembered; the pills in the game can still turn things on later.

export const PERMS_KEY = 'gt.perms'

/** Phones only (desktops have no GPS worth using indoors, or motion sensors), and only once. */
export function wantsPermissions(): boolean {
  try {
    if (localStorage.getItem(PERMS_KEY)) return false
  } catch {
    return false
  }
  return matchMedia('(pointer: coarse)').matches && ('geolocation' in navigator || 'DeviceMotionEvent' in window)
}

export interface PermResult {
  location: boolean
  motion: boolean
}

export function PermissionsSheet({ onDone }: { onDone: (r: PermResult | null) => void }) {
  const [busy, setBusy] = useState(false)
  const finish = (r: PermResult | null) => {
    try {
      localStorage.setItem(PERMS_KEY, r ? JSON.stringify(r) : 'skipped')
    } catch {
      /* private mode: we'll ask again next time */
    }
    onDone(r)
  }
  const allow = () => {
    setBusy(true)
    // both prompts start inside this tap (iOS needs the gesture for motion)
    const motion = requestMotion()
    const location = requestLocation()
    Promise.all([location, motion]).then(([l, m]) => finish({ location: l, motion: m }))
  }
  return (
    <div className="perm-backdrop">
      <div className="perm-card" role="dialog" aria-modal="true" aria-labelledby="perm-title">
        <strong id="perm-title" className="perm-title">
          Location &amp; motion
        </strong>
        <p className="perm-lead">So your bean moves with you at Klaus. Allow both once:</p>
        <ul className="perm-list">
          <li>
            <span className="perm-ico" aria-hidden="true">📍</span>
            <span>
              <b>Location</b>
              where you are in the atrium
            </span>
          </li>
          <li>
            <span className="perm-ico" aria-hidden="true">🧭</span>
            <span>
              <b>Motion &amp; compass</b>
              your steps between GPS updates
            </span>
          </li>
        </ul>
        <button className="start" type="button" onClick={allow} disabled={busy}>
          {busy ? 'Waiting for your phone…' : 'Allow ▸'}
        </button>
        <button className="perm-skip" type="button" onClick={() => finish(null)} disabled={busy}>
          Not now, I'll use the joystick
        </button>
      </div>
    </div>
  )
}
