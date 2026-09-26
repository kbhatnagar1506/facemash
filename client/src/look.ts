// A bean's look, as chosen in /avatar. Sent to the server as a short string
// ("b=#ff8a3d;a=#ffffff;p=split;e=dots;h=crown") so everyone sees your bean.

export const PATTERNS = ['solid', 'split', 'stripes', 'dots', 'zigzag', 'hearts'] as const
export const EYES = ['dots', 'happy', 'sleepy', 'wink', 'star', 'shades'] as const
export const HATS = ['none', 'cap', 'crown', 'bunny', 'bucket', 'propeller', 'halo', 'party', 'headphones'] as const
export const ITEMS = ['none', 'laptop', 'coffee', 'boba', 'phone', 'duck', 'energy', 'trophy'] as const
/** Logos a bean can wear on its belly (sponsor beans). */
export const LOGOS = ['none', 'hackgt', 'mlh', 'visa', 'tmobile', 'citadel', 'aramco', 'notability', 'nsa', 'meta', 'impiricus', 'spacex'] as const

export type Pattern = (typeof PATTERNS)[number]
export type Eyes = (typeof EYES)[number]
export type Hat = (typeof HATS)[number]
export type Item = (typeof ITEMS)[number]
export type Logo = (typeof LOGOS)[number]

export interface Look {
  body: string
  accent: string
  pattern: Pattern
  eyes: Eyes
  hat: Hat
  item: Item
  logo?: Logo
}

export const BODY_COLORS = ['#ff8a3d', '#ff5d6c', '#ffc93c', '#7ad36b', '#3fc5f0', '#4f7fd6', '#9b6bd1', '#ff7eb6', '#2bb3a6', '#f5f1e6', '#4a4e57', '#b86b3c']
export const ACCENT_COLORS = ['#ffffff', '#ffe066', '#ff5d6c', '#3fc5f0', '#7ad36b', '#9b6bd1', '#ff7eb6', '#1f2430', '#ff8a3d', '#2bb3a6']

const HEX = /^#[0-9a-fA-F]{6}$/

/** A cheerful default look built from a cap colour (for people who never visited /avatar). */
export function defaultLook(color = '#ff8a3d'): Look {
  return { body: HEX.test(color) ? color : '#ff8a3d', accent: '#ffffff', pattern: 'solid', eyes: 'dots', hat: 'none', item: 'laptop' }
}

export function encodeLook(l: Look) {
  return `b=${l.body};a=${l.accent};p=${l.pattern};e=${l.eyes};h=${l.hat};i=${l.item}` + (l.logo && l.logo !== 'none' ? `;l=${l.logo}` : '')
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
    else if (k === 'l' && (LOGOS as readonly string[]).includes(v)) l.logo = v as Logo
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

/** One bean per sponsor (and HackGT + MLH): brand colours, their logo on the belly, a fitting prop. */
export const SPONSOR_BEANS: { id: Exclude<Logo, 'none'>; name: string; look: Look }[] = [
  { id: 'hackgt', name: 'HackGT', look: { body: '#2bb3c0', accent: '#ffd23f', pattern: 'split', eyes: 'star', hat: 'bucket', item: 'duck', logo: 'hackgt' } },
  { id: 'mlh', name: 'MLH', look: { body: '#e73427', accent: '#ffc93c', pattern: 'split', eyes: 'happy', hat: 'party', item: 'laptop', logo: 'mlh' } },
  { id: 'visa', name: 'Visa', look: { body: '#1a1f71', accent: '#f7b600', pattern: 'split', eyes: 'dots', hat: 'cap', item: 'phone', logo: 'visa' } },
  { id: 'tmobile', name: 'T-Mobile', look: { body: '#e20074', accent: '#ffffff', pattern: 'solid', eyes: 'wink', hat: 'headphones', item: 'phone', logo: 'tmobile' } },
  { id: 'citadel', name: 'Citadel', look: { body: '#1f5fc4', accent: '#ffffff', pattern: 'stripes', eyes: 'dots', hat: 'none', item: 'coffee', logo: 'citadel' } },
  { id: 'aramco', name: 'Aramco', look: { body: '#00a3e0', accent: '#84bd00', pattern: 'split', eyes: 'happy', hat: 'bucket', item: 'trophy', logo: 'aramco' } },
  { id: 'notability', name: 'Notability', look: { body: '#63b8ea', accent: '#ffd23f', pattern: 'solid', eyes: 'star', hat: 'none', item: 'boba', logo: 'notability' } },
  { id: 'nsa', name: 'NSA', look: { body: '#18264a', accent: '#c9a14a', pattern: 'split', eyes: 'shades', hat: 'cap', item: 'coffee', logo: 'nsa' } },
  { id: 'meta', name: 'Meta', look: { body: '#0866ff', accent: '#ffffff', pattern: 'solid', eyes: 'happy', hat: 'none', item: 'laptop', logo: 'meta' } },
  { id: 'impiricus', name: 'Impiricus', look: { body: '#141418', accent: '#ff5d8f', pattern: 'zigzag', eyes: 'dots', hat: 'headphones', item: 'energy', logo: 'impiricus' } },
  { id: 'spacex', name: 'SpaceX', look: { body: '#eceff1', accent: '#111114', pattern: 'split', eyes: 'sleepy', hat: 'propeller', item: 'none', logo: 'spacex' } },
]
