import { N_SECTIONS, SECTIONS, type Section } from './path'
import { clamp } from './physics'

// The bridge between the page (DOM) and the scene (WebGL). The page measures where
// each section's copy sits and writes scroll anchors and camera framings here; the
// scene's Director reads them every frame and writes the progress bar and scrims back.

/** Camera framing for one section: how far, from which angle, and where on screen the bean sits. */
export interface Frame {
  dist: number
  pitch: number
  orbit: number
  /** where the bean's chest lands on screen, in NDC (-1..1) */
  nx: number
  ny: number
  fov: number
  /** where this section's copy starts (px from the top of the viewport) at its anchor;
   *  the phone scrim fades in just above it */
  copyTop: number
}

export interface Shared {
  /** scroll position (px) at which each section's copy is centred on screen */
  anchors: number[]
  maxScroll: number
  frames: Frame[]
  narrow: boolean
  reduced: boolean
  /** performance.now() when the page became ready (0 until then) */
  readyAt: number
  /** the scene has drawn its first frame */
  framed: boolean
  onFirstFrame: (() => void) | null
  progress: HTMLElement | null
  cue: HTMLElement | null
  scrimSide: HTMLElement | null
  scrimCenter: HTMLElement | null
  scrimBottom: HTMLElement | null
}

interface Style {
  pitch: number
  orbit: number
  dist: number
  max?: number
  /** width (world units) that must fit in the free area: one bean, or two in the finale */
  frameW?: number
  /** which side of the copy the bean stands on (desktop) */
  where: 'right' | 'below' | 'above'
  /** phones: orbit to use instead of half the desktop one */
  orbitNarrow?: number
  /** phones: where across the free area the bean stands (0..1), when the set piece needs the room beside it */
  cxNarrow?: number
  /** phones: where down the free area the bean stands (0..1), when the set piece needs the room above it */
  cyNarrow?: number
}

const STYLE: Record<Section, Style> = {
  hero: { pitch: 0.2, orbit: 0, dist: 8, where: 'below' },
  friend: { pitch: 0.42, orbit: -0.3, dist: 10.5, where: 'right' },
  // phones: swing round so the ring of four stands behind you, not off the right edge
  small: { pitch: 0.52, orbit: -0.22, dist: 13, where: 'right', orbitNarrow: -0.9 },
  crowd: { pitch: 0.62, orbit: 0, dist: 14, where: 'right' },
  strangers: { pitch: 0.95, orbit: 0, dist: 24, max: 30, where: 'below' },
  // phones: stand to the left of the row of tables, clear of the stuck bean, with the fix in frame
  bug: { pitch: 0.55, orbit: -0.38, dist: 13, where: 'right', orbitNarrow: -0.7, cxNarrow: 0.3, cyNarrow: 0.66 },
  apps: { pitch: 0.38, orbit: 0, dist: 9.5, where: 'right' },
  // the pair side by side on every screen (half the orbit would stand one behind the other)
  finale: { pitch: 0.3, orbit: 1.45, dist: 8.5, frameW: 3.6, where: 'above', orbitNarrow: 1.3 },
}

export function makeShared(): Shared {
  const H = typeof innerHeight === 'number' ? innerHeight : 800
  return {
    anchors: SECTIONS.map((_, i) => i * H),
    maxScroll: (N_SECTIONS - 1) * H,
    frames: SECTIONS.map((s) => ({
      dist: STYLE[s].dist,
      pitch: STYLE[s].pitch,
      orbit: STYLE[s].orbit,
      nx: s === 'hero' || s === 'finale' || s === 'strangers' ? 0 : 0.3,
      ny: -0.2,
      fov: 40,
      copyTop: H * 0.5,
    })),
    narrow: false,
    reduced: false,
    readyAt: 0,
    framed: false,
    onFirstFrame: null,
    progress: null,
    cue: null,
    scrimSide: null,
    scrimCenter: null,
    scrimBottom: null,
  }
}

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

/** Solve a section's framing from where its copy sits in the viewport at its anchor.
 *  H is the visible height (innerHeight: the small viewport while a phone's toolbar shows),
 *  CH the canvas height (the stage is 100lvh). Limits are laid out in the visible area;
 *  pixels become NDC over the canvas, which is what the camera projects onto. */
export function frameFor(sec: Section, copy: Rect, W: number, H: number, CH: number, navBottom: number, narrow: boolean): Frame {
  const st = STYLE[sec]
  const m = 24
  const top = navBottom + 8
  const where = narrow ? (sec === 'hero' ? 'below' : 'above') : st.where
  let x0 = m
  let x1 = W - m
  let y0 = top
  let y1 = H - m
  if (where === 'right') x0 = copy.right + m
  else if (where === 'below') y0 = copy.bottom + m
  // phones: the feet stay clear of the scrim that fades in above the copy
  else y1 = copy.top - m - (narrow ? 56 : 0)
  // the opening shot leaves the bottom of the screen to the scroll cue
  if (sec === 'hero') y1 = H - (narrow ? 72 : 96)
  // never let the free area collapse (very short or narrow windows)
  if (x1 - x0 < 160) x0 = x1 - 160
  if (y1 - y0 < 180) {
    const c = where === 'above' ? y1 - 90 : where === 'below' ? y0 + 90 : (y0 + y1) / 2
    // below the copy: run off the bottom of the screen rather than up over the words
    y0 = where === 'below' ? Math.max(y0, top) : clamp(c - 90, top, H - m - 180)
    y1 = y0 + 180
  }
  // on the side, stand toward the middle of the free area, clear of the copy's scrim;
  // the set pieces live further right. The finale pair sits a little low, off the nav.
  const cx = where === 'right' ? x0 + (x1 - x0) * 0.4 : narrow && st.cxNarrow !== undefined ? x0 + (x1 - x0) * st.cxNarrow : (x0 + x1) / 2
  const cy = sec === 'finale' ? y0 + (y1 - y0) * 0.56 : narrow && st.cyNarrow !== undefined ? y0 + (y1 - y0) * st.cyNarrow : (y0 + y1) / 2
  const aspect = W / CH
  const fov = aspect < 0.8 ? 44 : 40
  const tanHalf = Math.tan(((fov / 2) * Math.PI) / 180)
  const fh = ((y1 - y0) / CH) * 2
  const fw = ((x1 - x0) / W) * 2
  // height (world units) that must fit: one bean with room for a jump; the finale pair gets
  // extra headroom so the cap never crowds the nav
  const fitH = sec === 'finale' ? 3.3 : 2.8
  // phones: a step further back, so the set pieces around the bean stay in frame
  const need = Math.max(st.dist * (narrow ? 1.2 : 1), fitH / (fh * tanHalf), (st.frameW ?? 1.6) / (fw * tanHalf * aspect))
  return {
    dist: clamp(need, 6, (st.max ?? 18) * (narrow ? 1.25 : 1)),
    pitch: st.pitch + (narrow ? 0.06 : 0),
    orbit: narrow ? (st.orbitNarrow ?? st.orbit * 0.5) : st.orbit,
    nx: (cx / W) * 2 - 1,
    ny: 1 - (cy / CH) * 2,
    fov,
    copyTop: copy.top,
  }
}
