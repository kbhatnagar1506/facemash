// Klaus atrium floor plan, built from on-site photos (HackGT 13, Sept 2026).
// Metres; +x east (right as you walk in), +z south (towards the entrance doors).
// You enter from the south doors under a low mezzanine; the glass stair climbs
// north on your left to the 2nd-floor balcony; the checkerboard wall is the far
// (north) end; sponsor booths run down the right under the stacked balconies.

export const HALL = { w: 44, d: 56 }
export const X0 = -HALL.w / 2
export const X1 = HALL.w / 2
export const Z0 = -HALL.d / 2
export const Z1 = HALL.d / 2
export const CEIL = 22
export const L1 = 5 // 2nd-floor balcony height
export const MEZZ_Z = 3 // the raised entrance mezzanine runs from here (the Table 7 row) to the doors
/** Where the mezzanine's west wing starts (it only covers the stairwell beyond the stair foot). */
export const MEZZ_WEST_Z = 17.6
export const MEZZ_X0 = -14 // mezzanine's west edge over the stairwell
/** People are drawn at this scale inside Klaus so the building reads at true size. */
export const PERSON_SCALE = 0.62

/** Main entrance: the double glass doors on the east wall of the lobby (you walk in heading west). */
export const DOORS_Z = 22
export const HALL_SPAWN: [number, number] = [16.2, DOORS_Z]
export const HALL_EXIT: [number, number] = [20.7, DOORS_Z]
/** Camera heading on arrival: behind you to the east, looking west into the building. */
export const HALL_YAW = Math.PI / 2
/** Seminar Room West sits on the west wall, behind the stair foot. */
export const SEMINAR_Z = 24

/** Glass stair on the left as you enter: bottom at z=17 (ground), top at z=5 (balcony). */
export const STAIR = { x0: -19.5, x1: -15.5, zBottom: 17, zTop: 5, steps: 24 }

/** Walkable 2nd-floor balcony: the left run and the back-left run (L-shape). */
export const BALCONY = {
  left: { x0: X0, x1: -13, z0: Z0, z1: STAIR.zTop },
  back: { x0: X0, x1: -1, z0: Z0, z1: -14 },
}

/** Round white columns: [x, z, radius, height]. */
export const COLUMNS: [number, number, number, number][] = [
  [-13.2, 3.4, 0.4, L1],
  [-13.2, -5, 0.4, L1],
  [-8, -14.2, 0.4, L1],
  [-1.6, -14.2, 0.4, L1],
  ...[-22, -14, -6, 2, 10].map((z): [number, number, number, number] => [18.2, z, 0.45, 18.2]),
]

export interface Table {
  n: number
  x: number
  z: number
}
/** 10 hacking tables in the open floor, 2 columns × 5 rows. */
export const TABLES: Table[] = [-12, -6.5, -1, 4.5, 10].flatMap((z, row) =>
  [2.2, 9.8].map((x, col) => ({ n: row * 2 + col + 1, x, z })),
)
export const TABLE = { w: 3.4, d: 1.5, h: 0.78 }

type Box = [number, number, number, number] // x0, z0, x1, z1

/** Things on the ground floor you can't walk through. */
export const GROUND_BLOCKS: Box[] = [
  [X0, STAIR.zTop, STAIR.x1 + 0.4, STAIR.zBottom], // under/beside the stair (to the wall)
  [-0.45, -22.8, 4.45, -18.6], // photo booth frame
  [-0.7, -18.6, 4.7, -16.5], // the boat
  // back wall sponsor row (Notability, Visa, T-Mobile, Citadel, Aramco)
  [-7.4, -27.4, -2.3, -24.1],
  [-0.7, -27.4, 12.1, -25.1],
  [12.1, -27.9, 18.5, -25.5],
  [19.2, -25, 20, -23.6], // Aramco's folding chair
  // east windows (NSA, Meta, Impiricus, SpaceX)
  [20.1, -22.9, 21.9, -17.9],
  [20.1, -11.1, 21.1, -10.1], // Meta roll-up beside the long table
  [20.1, -13.9, 21.9, -11.1], // Meta long table
  [20.2, -6.7, 21.9, -1.3],
  [20.3, 0.4, 21.9, 3.3],
  [20.1, 6.1, 21.9, 8.9],
  // organizers
  [-15, 5.6, -13.6, 9.4], // Hardware Desk
  [-14.4, 14.8, -11.2, 16.2], // MLH at the stair foot
  [-3.7, -11.8, -1.9, -5.8], // HackGT Help Desk + the bear (beside Tables 1 & 3)
  // entrance lobby (photos: doors, Seminar Room West, Research Wing)
  [21.1, 16.1, 21.9, 16.9], // trash can by the doors
  [-12.2, 21.8, -9, 23.2], // folding tables outside Seminar Room West
  [-7.6, 23.4, -4.4, 24.8],
  [-21.9, 20.6, -21.1, 21.4], // recycling bin by Seminar Room West
  [6.4, 26.6, 7.3, 27.9], // info kiosk
  [13.2, 25.6, 15.6, 27.9], // folding table + chair
  ...TABLES.map((t): Box => [t.x - 2, t.z - 1.6, t.x + 2, t.z + 1.6]),
]

function inBox(x: number, z: number, [x0, z0, x1, z1]: Box, r: number) {
  return x > x0 - r && x < x1 + r && z > z0 - r && z < z1 + r
}

const R = 0.32 // player radius (people are scaled down inside Klaus)

function groundOk(x: number, z: number) {
  if (x < X0 + 0.6 + R || z < Z0 + 0.6 + R || z > Z1 - 0.6 - R) return false
  // East wall: only the entrance doorway lets you out to the exit shell.
  if (x > X1 - 0.6 - R && Math.abs(z - DOORS_Z) > 2.3) return false
  if (x > X1 + 1) return false
  if (GROUND_BLOCKS.some((b) => inBox(x, z, b, R))) return false
  return !COLUMNS.some(([cx, cz, cr]) => Math.hypot(x - cx, z - cz) < cr + R)
}

function stairHeight(x: number, z: number): number | null {
  if (x < STAIR.x0 + R || x > STAIR.x1 - R || z < STAIR.zTop - 0.01 || z > STAIR.zBottom + 0.6) return null
  const t = THREE_clamp((STAIR.zBottom - z) / (STAIR.zBottom - STAIR.zTop), 0, 1)
  return t * L1
}

function balconyOk(x: number, z: number) {
  const { left, back } = BALCONY
  const onStairTop = x > STAIR.x0 + R && x < STAIR.x1 - R
  // Left run: its east edge is open where it meets the mezzanine (z between MEZZ_Z and the stair top).
  const leftX1 = z > MEZZ_Z + R ? left.x1 + 0.5 : left.x1 - R
  const inLeft = x > left.x0 + 0.6 + R && x < leftX1 && z > left.z0 + 0.6 + R && z < left.z1 - (onStairTop ? -0.01 : R)
  const inBack = x > back.x0 + 0.6 + R && x < back.x1 - R && z > back.z0 + 0.6 + R && z < back.z1 - R
  // Entrance mezzanine (walk onto it from the balcony), plus its west wing over the stair foot.
  const inMezz = x > MEZZ_X0 + R && x < X1 - 0.6 - R && z > MEZZ_Z + R && z < Z1 - 0.6 - R
  const inMezzWest = x > X0 + 0.6 + R && x < MEZZ_X0 + 0.5 && z > MEZZ_WEST_Z + R && z < Z1 - 0.6 - R
  return inLeft || inBack || inMezz || inMezzWest
}

function THREE_clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}

/**
 * Multi-level collision: returns the floor height you'd stand on at (x, z) when
 * coming from height y (ground, stair ramp, or balcony), or null if blocked.
 * Levels only connect where heights meet (the ends of the stair), so the
 * balcony edge acts as a railing and you can't clip onto the stair from the side.
 */
export class HallCollider {
  surface(x: number, z: number, y: number): number | null {
    let best: number | null = null
    let bestD = 0.75
    const consider = (h: number | null) => {
      if (h === null) return
      const d = Math.abs(h - y)
      if (d <= bestD) {
        bestD = d
        best = h
      }
    }
    if (groundOk(x, z)) consider(0)
    consider(stairHeight(x, z))
    if (balconyOk(x, z)) consider(L1)
    return best
  }
  blocked(x: number, z: number): boolean {
    return this.surface(x, z, 0) === null
  }
}

/** Height of the walkable floor at (x, z) nearest to y; used for NPCs walking the stair. */
export function floorAt(x: number, z: number, y: number) {
  return new HallCollider().surface(x, z, y) ?? y
}

export interface Spot {
  id: string
  x: number
  z: number
  y?: number
  r: number
  text: string
  action?: 'schedule' | 'tracks' | 'photo'
}

export const SPOTS: Spot[] = [
  { id: 'helpdesk', x: -1.1, z: -9.2, r: 2.4, text: 'HackGT Help Desk: questions, lost & found, and the full schedule. Press E.', action: 'schedule' },
  { id: 'photo', x: 2, z: -15.8, r: 2.4, text: '📸 The HackGT 13 photo booth. Hop in the boat! Press E to take a photo.', action: 'photo' },
  { id: 'hardware', x: -12.4, z: 7.5, r: 2.6, text: 'Hardware Desk: check out Arduinos, sensors, cables… the line is long for a reason.' },
  { id: 'mlh', x: -12.8, z: 17.2, r: 2.4, text: 'Major League Hacking: stickers, swag and challenge cards.' },
  { id: 'notability', x: -6, z: -23.2, r: 2.4, text: 'Notability: “the app your semester runs on.” Download it now.' },
  { id: 'visa', x: 0.6, z: -24.2, r: 1.8, text: 'Visa: chat with engineers about payments at planet scale.' },
  { id: 'tmobile', x: 4.6, z: -24.2, r: 1.8, text: 'T-Mobile: “Unstoppable. Together.” Explore what’s possible.' },
  { id: 'citadel', x: 10.3, z: -24.2, r: 2, text: 'Citadel | Citadel Securities: Welcome! Scan the QR to connect.' },
  { id: 'aramco', x: 15.3, z: -24.5, r: 2.6, text: 'Aramco: presenting the Social Good track, “A Marina’s Mission.”' },
  { id: 'nsa', x: 19.2, z: -20, r: 2.4, text: 'National Security Agency: IntelligenceCareers.gov/NSA' },
  { id: 'meta', x: 19.1, z: -12, r: 2.4, text: 'Meta: “Make Every Connection Matter.” Come say hi at the table.' },
  { id: 'impiricus', x: 19.2, z: -4, r: 2.4, text: 'Impiricus: the Agentic Commercialization Platform for Healthcare. self.build()' },
  { id: 'spacex', x: 19.2, z: 7.5, r: 2.2, text: 'SpaceX: ask about building rockets.' },
  { id: 'balcony', x: -17.5, z: -8, y: L1, r: 5, text: 'Up on the 2nd floor: the whole Seaside Market below you.' },
  { id: 'mezz', x: 4, z: 4.6, y: L1, r: 6, text: 'The entrance mezzanine: look out over the hacking floor and the photo booth.' },
  { id: 'seminar', x: -20, z: SEMINAR_Z, r: 2.6, text: 'Seminar Room West: workshops and tech talks happen in here.' },
  { id: 'research', x: 10, z: 26.2, r: 2.6, text: 'Klaus Research Wing: the 1100s. Directions to the classroom wing are on the kiosk.' },
  { id: 'tv', x: 13.4, z: 26.5, r: 2.2, text: 'The lobby screen: “AI4OPT Showcase & Social.”' },
]

export function nearestSpot(x: number, z: number, y: number): Spot | null {
  let best: Spot | null = null
  let bestD = Infinity
  for (const s of SPOTS) {
    if (Math.abs((s.y ?? 0) - y) > 1.5) continue
    const d = Math.hypot(s.x - x, s.z - z)
    if (d < s.r && d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

/** Nearest hacking table within `range` metres of (x, z) on the ground floor. */
export function nearestTable(x: number, z: number, y = 0, range = 2.8): Table | null {
  if (y > 0.5) return null
  let best: Table | null = null
  let bestD = range
  for (const t of TABLES) {
    const dx = Math.max(0, Math.abs(x - t.x) - TABLE.w / 2)
    const dz = Math.max(0, Math.abs(z - t.z) - TABLE.d / 2)
    const d = Math.hypot(dx, dz)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

/**
 * Highest the third-person camera may go at (x, z) for a player at height py,
 * so it never pokes through the low ceilings (entrance mezzanine, under balconies).
 */
export function cameraCeiling(x: number, z: number, py: number): number {
  if (py < 2) {
    const underSlab =
      (z > MEZZ_Z - 0.3 && (x > MEZZ_X0 - 0.3 || z > MEZZ_WEST_Z - 0.3)) ||
      (x < BALCONY.left.x1 + 0.3 && z < BALCONY.left.z1 + 0.3) ||
      (x < BALCONY.back.x1 + 0.3 && z < BALCONY.back.z1 + 0.3) ||
      x > 18.3
    if (underSlab) return L1 - 0.9
  }
  return CEIL - 1
}
