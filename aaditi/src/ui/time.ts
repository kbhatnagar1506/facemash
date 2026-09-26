import { useEffect, useState } from 'react'

const pad = (n: number) => String(n).padStart(2, '0')

export const hms = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// full local timestamp with offset, for tooltips
export const stamp = (t: number) => {
  const d = new Date(t)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${date} ${hms(t)}.${ms} UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

export const ago = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const spinner = (t: number) => FRAMES[Math.floor(t / 80) % FRAMES.length]

export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
