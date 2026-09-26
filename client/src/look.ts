// A bean's look, as chosen in /avatar. Sent to the server as a short string
// ("b=#ff8a3d;a=#ffffff;p=split;e=dots;h=crown") so everyone sees your bean.

export const PATTERNS = ['solid', 'split', 'stripes', 'dots', 'zigzag', 'hearts'] as const
export const EYES = ['dots', 'happy', 'sleepy', 'wink', 'star', 'shades'] as const
export const HATS = ['none', 'cap', 'crown', 'bunny', 'bucket', 'propeller', 'halo', 'party', 'headphones'] as const
export const ITEMS = ['none', 'laptop', 'coffee', 'boba', 'phone', 'duck', 'energy', 'trophy'] as const

export type Pattern = (typeof PATTERNS)[number]
export type Eyes = (typeof EYES)[number]
export type Hat = (typeof HATS)[number]
export type Item = (typeof ITEMS)[number]

export interface Look {
  body: string
  accent: string
  pattern: Pattern
  eyes: Eyes
  hat: Hat
  item: Item
}

export const BODY_COLORS = ['#ff8a3d', '#ff5d6c', '#ffc93c', '#7ad36b', '#3fc5f0', '#4f7fd6', '#9b6bd1', '#ff7eb6', '#2bb3a6', '#f5f1e6', '#4a4e57', '#b86b3c']
export const ACCENT_COLORS = ['#ffffff', '#ffe066', '#ff5d6c', '#3fc5f0', '#7ad36b', '#9b6bd1', '#ff7eb6', '#1f2430', '#ff8a3d', '#2bb3a6']

const HEX = /^#[0-9a-fA-F]{6}$/

/** A cheerful default look built from a cap colour (for people who never visited /avatar). */
export function defaultLook(color = '#ff8a3d'): Look {
  return { body: HEX.test(color) ? color : '#ff8a3d', accent: '#ffffff', pattern: 'split', eyes: 'dots', hat: 'none', item: 'laptop' }
}

export function encodeLook(l: Look) {
  return `b=${l.body};a=${l.accent};p=${l.pattern};e=${l.eyes};h=${l.hat};i=${l.item}`
}

export function decodeLook(s: string | undefined, fallbackColor?: string): Look {
  const l = defaultLook(fallbackColor)
  if (!s) return l
  for (const part of s.split(';')) {
    const [k, v] = part.split('=')
    if (k === 'b' && HEX.test(v)) l.body = v
    else if (k === 'a' && HEX.test(v)) l.accent = v
    else if (k === 'p' && (PATTERNS as readonly string[]).includes(v)) l.pattern = v as Pattern
    else if (k === 'e' && (EYES as readonly string[]).includes(v)) l.eyes = v as Eyes
    else if (k === 'h' && (HATS as readonly string[]).includes(v)) l.hat = v as Hat
    else if (k === 'i' && (ITEMS as readonly string[]).includes(v)) l.item = v as Item
  }
  return l
}

export function randomLook(): Look {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]
  const body = pick(BODY_COLORS)
  let accent = pick(ACCENT_COLORS)
  if (accent === body) accent = '#ffffff'
  return { body, accent, pattern: pick(PATTERNS), eyes: pick(EYES), hat: pick(HATS), item: pick(ITEMS) }
}

const KEY = 'gt.look'
export function loadLook(): Look | null {
  try {
    const s = localStorage.getItem(KEY)
    return s ? decodeLook(s) : null
  } catch {
    return null
  }
}
export function saveLook(l: Look) {
  try {
    localStorage.setItem(KEY, encodeLook(l))
  } catch {
    /* private mode: the look still applies for this visit */
  }
}
