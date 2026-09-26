import { RING } from './data'

// Bean profile pictures. Three poses, each zoomed onto the bean's face; every person gets a pose
// and a hue shift so no two people in the same chat look alike.

const POSES = [
  { src: '/avatars/bean-pink.webp', fx: '50%', fy: '14%', zoom: 1.75, hue: 300 },
  { src: '/avatars/bean-dab.webp', fx: '14%', fy: '38%', zoom: 1.45, hue: 200 },
  { src: '/avatars/bean-orange.webp', fx: '56%', fy: '24%', zoom: 1.8, hue: 25 },
]

// spread people around the colour wheel; neighbours on the ring (who tend to chat) differ most
function look(id: string) {
  const i = Math.max(0, RING.indexOf(id))
  const pose = POSES[i % POSES.length]
  const target = (i * 137.5) % 360
  return { pose, rotate: Math.round(target - pose.hue) }
}

export function Avatar({ id, size = 28, className = '' }: { id: string; size?: number; className?: string }) {
  const { pose, rotate } = look(id)
  return (
    <span className={`pfp ${className}`} style={{ width: size, height: size }} aria-hidden>
      <img
        src={pose.src}
        alt=""
        draggable={false}
        style={{ transformOrigin: `${pose.fx} ${pose.fy}`, transform: `scale(${pose.zoom})`, filter: `hue-rotate(${rotate}deg) saturate(1.1)` }}
      />
    </span>
  )
}
