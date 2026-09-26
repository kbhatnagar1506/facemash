import { useEffect, useRef, useState } from 'react'

// Pedestrian dead reckoning from the phone's own sensors (no app, no step-counter API):
//  - steps: the phone bounces with every stride, so we watch the accelerometer's
//    magnitude and count each bounce (with a minimum gap so one step isn't two);
//  - heading: the compass (iOS: webkitCompassHeading; Android: absolute orientation).
// Every step is reported with the heading at that moment; the GPS fusion in App.tsx
// turns steps into movement and uses GPS to correct the slow drift.

export type MotionStatus = 'off' | 'asking' | 'on' | 'denied' | 'unsupported'

type IOSPermission = { requestPermission?: () => Promise<'granted' | 'denied'> }

/** Ask for motion + compass access. Must run from a tap on iOS; resolves to whether it's allowed. */
export async function requestMotion(): Promise<boolean> {
  try {
    const dm = (window as unknown as { DeviceMotionEvent?: IOSPermission }).DeviceMotionEvent
    const dor = (window as unknown as { DeviceOrientationEvent?: IOSPermission }).DeviceOrientationEvent
    // both asked synchronously, inside the same tap: after an await iOS may no longer
    // count it as the user's gesture and refuses the second prompt
    const [a, b] = await Promise.all([
      dm?.requestPermission ? dm.requestPermission() : Promise.resolve('granted' as const),
      dor?.requestPermission ? dor.requestPermission() : Promise.resolve('granted' as const),
    ])
    return a === 'granted' && b === 'granted'
  } catch {
    return false
  }
}

/**
 * While `enabled`, calls onStep(headingDeg) for each detected step (heading clockwise
 * from true/magnetic north). Status tells the UI whether sensor data is actually flowing.
 */
export function useMotion(enabled: boolean, onStep: (heading: number) => void) {
  const [status, setStatus] = useState<MotionStatus>('off')
  const cb = useRef(onStep)
  cb.current = onStep
  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      return
    }
    if (!('DeviceMotionEvent' in window)) {
      setStatus('unsupported')
      return
    }
    let heading: number | null = null
    let gotMotion = false
    let lp = 9.81 // low-passed acceleration magnitude
    let up = false
    let lastStep = 0
    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity
      if (!g || g.x == null || g.y == null || g.z == null) return
      if (!gotMotion) {
        gotMotion = true
        setStatus('on')
      }
      const m = Math.hypot(g.x, g.y, g.z)
      lp += (m - lp) * 0.25
      const now = performance.now()
      // a stride pushes the magnitude up past ~1 m/s² over gravity and back down
      if (!up && lp > 10.9 && now - lastStep > 300) {
        up = true
        lastStep = now
        if (heading != null) cb.current(heading)
      } else if (up && lp < 9.9) up = false
    }
    const screenAngle = () => (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number
    // compass readings wobble indoors: smooth them on the circle (so 359° and 1° average to 0°)
    let hs = 0
    let hc = 0
    const onOrient = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
      let h: number | null = null
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading // iOS: already compass degrees
      else if (e.absolute && e.alpha != null) h = (360 - e.alpha + screenAngle()) % 360 // Android absolute
      if (h == null) return
      const r = (h * Math.PI) / 180
      if (heading == null) {
        hs = Math.sin(r)
        hc = Math.cos(r)
      } else {
        hs += (Math.sin(r) - hs) * 0.2
        hc += (Math.cos(r) - hc) * 0.2
      }
      heading = ((Math.atan2(hs, hc) * 180) / Math.PI + 360) % 360
    }
    window.addEventListener('devicemotion', onMotion)
    const absEvent = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
    window.addEventListener(absEvent, onOrient as EventListener)
    // no sensor data within 3 s: this device/browser doesn't provide it (or it's switched off)
    const t = setTimeout(() => !gotMotion && setStatus('unsupported'), 3000)
    return () => {
      clearTimeout(t)
      window.removeEventListener('devicemotion', onMotion)
      window.removeEventListener(absEvent, onOrient as EventListener)
    }
  }, [enabled])
  return status
}
