import { useLayoutEffect, useRef, useState } from 'react'
import type { Rec } from './recorder'
import { hm } from './time'

// Events recorded per hour over the last 24 h. One series, so one neutral bar colour and no legend;
// the title names it. Hover any hour for its count; "table" shows the same numbers as a table.

const H = 3_600_000
const HEIGHT = 170
const PAD = { l: 36, r: 8, t: 12, b: 24 }

function scale(max: number) {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => s * 4 >= max) ?? 1000
  return { step, top: step * 4 }
}

function bar(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, h, w / 2) // rounded data end, square at the baseline
  return `M${x},${y + h} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h} Z`
}

export function HourChart({ events, now }: { events: Rec[]; now: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const hour = new Date(now)
  hour.setMinutes(0, 0, 0)
  const end = hour.getTime() + H
  const buckets = Array.from({ length: 24 }, (_, i) => ({ start: end - (24 - i) * H, n: 0 }))
  for (const r of events) {
    const i = Math.floor((r.at - (end - 24 * H)) / H)
    if (i >= 0 && i < 24) buckets[i].n++
  }
  const { step, top } = scale(Math.max(1, ...buckets.map((b) => b.n)))
  const plotW = Math.max(100, width - PAD.l - PAD.r)
  const plotH = HEIGHT - PAD.t - PAD.b
  const band = plotW / 24
  const bw = Math.min(24, band * 0.68)
  const every = width < 520 ? 6 : 3
  const total = buckets.reduce((s, b) => s + b.n, 0)
  const peak = buckets.reduce((p, b) => (b.n > p.n ? b : p), buckets[0])

  return (
    <section className="panel chart">
      <header className="panel-head">
        <div>
          <h2>Events recorded per hour</h2>
          <p className="sub">
            Last 24 h · {total.toLocaleString()} events · busiest {hm(peak.start)}–{hm(peak.start + H)} ({peak.n})
          </p>
        </div>
        <button className="btn ghost small" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? 'chart' : 'table'}
        </button>
      </header>

      {table ? (
        <div className="hour-table">
          <table>
            <thead>
              <tr>
                <th>Hour</th>
                <th className="num">Events</th>
              </tr>
            </thead>
            <tbody>
              {[...buckets].reverse().map((b) => (
                <tr key={b.start}>
                  <td>
                    {hm(b.start)}–{hm(b.start + H)}
                    {b.start + H === end ? ' (now)' : ''}
                  </td>
                  <td className="num">{b.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="plot" ref={box}>
          <svg width={width} height={HEIGHT} role="img" aria-label={`Events per hour over the last 24 hours, ${total} in total`}>
            {Array.from({ length: 5 }, (_, i) => {
              const v = i * step
              const y = PAD.t + plotH - (v / top) * plotH
              return (
                <g key={i}>
                  <line x1={PAD.l} x2={PAD.l + plotW} y1={y} y2={y} className="grid" />
                  <text x={PAD.l - 8} y={y} className="tick" textAnchor="end" dominantBaseline="middle">
                    {v.toLocaleString()}
                  </text>
                </g>
              )
            })}
            {buckets.map((b, i) => {
              const h = (b.n / top) * plotH
              const x = PAD.l + i * band + (band - bw) / 2
              const isNow = i === 23
              return (
                <g key={b.start} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={PAD.l + i * band} y={PAD.t} width={band} height={plotH} className="hit" />
                  {b.n > 0 && <path d={bar(x, PAD.t + plotH - h, bw, h)} className={`bar${hover === i ? ' on' : ''}${isNow ? ' now' : ''}`} />}
                  {(i % every === 2 || isNow) && (
                    <text x={PAD.l + i * band + band / 2} y={HEIGHT - 6} className={`tick${isNow ? ' now' : ''}`} textAnchor="middle">
                      {isNow ? 'now' : hm(b.start)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {hover !== null && (
            <div
              className="tip"
              style={{
                left: Math.min(width - 150, Math.max(0, PAD.l + hover * band + band / 2 - 75)),
                top: Math.max(0, PAD.t + plotH - (buckets[hover].n / top) * plotH - 52),
              }}
            >
              <b>{buckets[hover].n} events</b>
              <span>
                {hm(buckets[hover].start)}–{hm(buckets[hover].start + H)}
                {hover === 23 ? ', so far' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
