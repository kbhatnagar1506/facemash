// Writes server/talkdata/hall_grid.json: the hall's ground-floor walkable cells (0.5 m),
// from the same HallCollider the game uses, so server-driven NPCs walk around tables,
// columns and booths. Run: node --experimental-strip-types scripts/hall_grid.mts
import { writeFileSync } from 'node:fs'
import { HALL_BOUNDS, HallCollider } from '../client/src/hall/layout.ts'

const STEP = 0.5
const col = new HallCollider()
const [x0, z0, x1, z1] = HALL_BOUNDS
const w = Math.ceil((x1 - x0) / STEP) + 1
const h = Math.ceil((z1 - z0) / STEP) + 1
const rows: string[] = []
for (let k = 0; k < h; k++) {
  let row = ''
  for (let i = 0; i < w; i++) {
    const x = x0 + i * STEP
    const z = z0 + k * STEP
    // walkable with a little room around it (a bean is ~0.7 m wide)
    const ok = [[0, 0], [0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]].every(([dx, dz]) => col.surface(x + dx, z + dz, 0) === 0)
    row += ok ? '.' : '#'
  }
  rows.push(row)
}
writeFileSync(new URL('../server/talkdata/hall_grid.json', import.meta.url), JSON.stringify({ x0, z0, step: STEP, rows }) + '\n')
console.log(`hall grid ${w}x${h}, walkable ${rows.join('').split('.').length - 1}`)
