import { memo } from 'react'
import { decodeLook } from '../../look'

// Bean profile pictures. Three poses, each zoomed onto the bean's face. The pose comes from the
// person's id; the colour comes from their Bean Studio look (body colour), so a person's picture
// here matches the bean they walk around with in the game.

const POSES = [
  { src: '/avatars/bean-pink.webp', fx: '50%', fy: '14%', zoom: 1.75, hue: 300 },
  { src: '/avatars/bean-dab.webp', fx: '14%', fy: '38%', zoom: 1.45, hue: 200 },
  { src: '/avatars/bean-orange.webp', fx: '56%', fy: '24%', zoom: 1.8, hue: 25 },
]

function hsl(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: (h * 60 + 360) % 360, s, l }
}

const cache = new Map<string, { pose: (typeof POSES)[number]; filter: string; ring: string }>()
function look(seed: number | string, bean: string) {
  const key = `${seed}|${bean}`
  let v = cache.get(key)
  if (!v) {
    const n = typeof seed === 'number' ? seed : [...seed].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7)
    const pose = POSES[Math.abs(n) % POSES.length]
    const l = decodeLook(bean)
    const c = hsl(l.body)
    // near-grey bodies (cream, charcoal) desaturate instead of rotating the hue
    const filter =
      c.s < 0.25
        ? `grayscale(1) brightness(${(0.55 + c.l * 0.7).toFixed(2)})`
        : `hue-rotate(${Math.round(c.h - pose.hue)}deg) saturate(${(0.8 + c.s * 0.5).toFixed(2)}) brightness(${(0.8 + c.l * 0.4).toFixed(2)})`
    v = { pose, filter, ring: l.accent }
    cache.set(key, v)
  }
  return v
}

type Props = { seed: number | string; bean: string; size?: number; className?: string }

export const Avatar = memo(function Avatar({ seed, bean, size = 28, className = '' }: Props) {
  const { pose, filter } = look(seed, bean)
  return (
    <span className={`pfp ${className}`} style={{ width: size, height: size }} aria-hidden>
      <img
        src={pose.src}
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
        style={{ transformOrigin: `${pose.fx} ${pose.fy}`, transform: `scale(${pose.zoom})`, filter }}
      />
    </span>
  )
})
