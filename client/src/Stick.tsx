import { useRef, useState, type PointerEvent } from 'react'
import { stick } from './touch'

const R = 44 // how far the knob travels from the centre, px

/** Thumbstick for moving on phones: drag from the pad; push to the rim to run. */
export function Stick() {
  const base = useRef<HTMLDivElement>(null!)
  const id = useRef(-1)
  const [knob, setKnob] = useState<[number, number]>([0, 0])
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id.current) return
    const r = base.current.getBoundingClientRect()
    let x = e.clientX - (r.left + r.width / 2)
    let y = e.clientY - (r.top + r.height / 2)
    const d = Math.hypot(x, y)
    if (d > R) {
      x = (x / d) * R
      y = (y / d) * R
    }
    const m = Math.min(1, d / R)
    // a small dead zone so resting a thumb on it doesn't creep
    const on = m > 0.18
    stick.x = on ? x / R : 0
    stick.z = on ? y / R : 0
    stick.run = m > 0.92
    setKnob([x, y])
  }
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id.current) return
    id.current = -1
    stick.x = stick.z = 0
    stick.run = false
    setKnob([0, 0])
  }
  return (
    <div
      className="stick"
      ref={base}
      aria-hidden="true"
      onPointerDown={(e) => {
        if (id.current !== -1) return
        id.current = e.pointerId
        e.currentTarget.setPointerCapture(e.pointerId)
        move(e)
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      <div className="stick-knob" style={{ transform: `translate(${knob[0]}px, ${knob[1]}px)` }} />
    </div>
  )
}
