import { HALL_BOUNDS, HallCollider } from './layout'

// A walking route on the hall's ground floor, around tables, columns and booths: a
// breadth-first search over a 0.5 m grid, then trimmed to the corners you'd actually
// turn at (a straight line between two kept points never crosses anything).

const STEP = 0.5
const col = new HallCollider()
const walkable = (x: number, z: number) => col.surface(x, z, 0) === 0

function clear(ax: number, az: number, bx: number, bz: number) {
  const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25)
  for (let i = 1; i < n; i++) if (!walkable(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)) return false
  return true
}

/** Waypoints from `from` to `to` (both [x, z]), ending exactly at `to`; [] if there's no way. */
export function hallPath(from: [number, number], to: [number, number]): [number, number][] {
  const [x0, z0, x1, z1] = HALL_BOUNDS
  const w = Math.ceil((x1 - x0) / STEP) + 1
  const h = Math.ceil((z1 - z0) / STEP) + 1
  const cell = (x: number, z: number): [number, number] => [Math.round((x - x0) / STEP), Math.round((z - z0) / STEP)]
  const at = (i: number, k: number): [number, number] => [x0 + i * STEP, z0 + k * STEP]
  const ok = (i: number, k: number) => i >= 0 && k >= 0 && i < w && k < h && walkable(...at(i, k))
  // start and goal snap to the nearest walkable cell (you might stand right at a table's edge)
  const snap = ([x, z]: [number, number]): [number, number] | null => {
    const [ci, ck] = cell(x, z)
    for (let r = 0; r <= 6; r++)
      for (let di = -r; di <= r; di++)
        for (let dk = -r; dk <= r; dk++) if (Math.max(Math.abs(di), Math.abs(dk)) === r && ok(ci + di, ck + dk)) return [ci + di, ck + dk]
    return null
  }
  const s = snap(from)
  const g = snap(to)
  if (!s || !g) return []
  const prev = new Int32Array(w * h).fill(-1)
  const start = s[1] * w + s[0]
  const goal = g[1] * w + g[0]
  prev[start] = start
  const queue = [start]
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  for (let q = 0; q < queue.length && prev[goal] < 0; q++) {
    const c = queue[q]
    const i = c % w
    const k = (c - i) / w
    for (const [di, dk] of dirs) {
      const ni = i + di
      const nk = k + dk
      const n = nk * w + ni
      if (ni < 0 || nk < 0 || ni >= w || nk >= h || prev[n] >= 0 || !ok(ni, nk)) continue
      if (di && dk && (!ok(i + di, k) || !ok(i, k + dk))) continue // no cutting corners
      prev[n] = c
      queue.push(n)
    }
  }
  if (prev[goal] < 0) return []
  const cells: [number, number][] = []
  for (let c = goal; ; c = prev[c]) {
    const i = c % w
    cells.push(at(i, (c - i) / w))
    if (c === start) break
  }
  cells.reverse()
  // keep only the turns
  const out: [number, number][] = []
  let a: [number, number] = [from[0], from[1]]
  for (let j = 1; j < cells.length; j++) {
    if (!clear(a[0], a[1], cells[j][0], cells[j][1])) {
      out.push(cells[j - 1])
      a = cells[j - 1]
    }
  }
  out.push([to[0], to[1]])
  // long straight stretches in steps of at most 8 m (the game jumps to far-off targets)
  const walk: [number, number][] = []
  let p: [number, number] = [from[0], from[1]]
  for (const q of out) {
    const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 8)
    for (let i = 1; i <= n; i++) walk.push([p[0] + ((q[0] - p[0]) * i) / n, p[1] + ((q[1] - p[1]) * i) / n])
    p = q
  }
  return walk
}
