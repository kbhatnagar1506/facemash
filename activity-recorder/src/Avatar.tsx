import { ORDER } from './data'

// Bean profile pictures: three poses zoomed onto the face, and a hue per person.

const POSES = [
  { src: '/avatars/bean-pink.webp', fx: '50%', fy: '14%', zoom: 1.75, hue: 300 },
  { src: '/avatars/bean-dab.webp', fx: '14%', fy: '38%', zoom: 1.45, hue: 200 },
  { src: '/avatars/bean-orange.webp', fx: '56%', fy: '24%', zoom: 1.8, hue: 25 },
]

function look(id: string) {
  const i = Math.max(0, ORDER.indexOf(id))
  const pose = POSES[i % POSES.length]
  return { pose, rotate: Math.round(((i * 137.5) % 360) - pose.hue) }
}

export function Avatar({ id, size = 28, off = false }: { id: string; size?: number; off?: boolean }) {
  const { pose, rotate } = look(id)
  return (
    <span className={`pfp${off ? ' off' : ''}`} style={{ width: size, height: size }} aria-hidden>
      <img
        src={pose.src}
        alt=""
        draggable={false}
        style={{ transformOrigin: `${pose.fx} ${pose.fy}`, transform: `scale(${pose.zoom})`, filter: `hue-rotate(${rotate}deg) saturate(1.1)` }}
      />
    </span>
  )
}
