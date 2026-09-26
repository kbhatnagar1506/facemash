import * as THREE from 'three'

// Warming the atrium up while you're still outside, so walking in (and the entrance
// fly-through) doesn't stall. Everything the first hall frames would do on the spot is
// done ahead, in small idle-time slices, with the hall's own lighting and render target:
//
//  1. compile  every shader the hall draws with (hall materials plus your bean and the
//              other players, which get new variants under the hall's lights), in parallel
//              where the browser can (KHR_parallel_shader_compile), then finish each
//              program's link check and uniform lookup one at a time;
//  2. upload   their textures;
//  3. one hidden frame through the hall's post-processing, drawn before the campus frame
//              (which then paints over all of it): geometry, shadow and effect shaders,
//              render targets.
//
// Nothing here changes what anything looks like; it only moves the work earlier.

type Program = { isReady?: () => boolean; getUniforms: () => unknown; getAttributes: () => unknown }
export type Composer = { render: (dt?: number) => void; setSize: (w: number, h: number) => void }

const ric = typeof requestIdleCallback === 'function' ? requestIdleCallback.bind(globalThis) : null
/** Wait for the browser to be idle (a frame's leftover time), or ~a frame if it can't say. */
export const idle = () => new Promise<void>((r) => (ric ? ric(() => r(), { timeout: 120 }) : setTimeout(r, 32)))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Run `work` over `items` in slices of at most ~`budget` ms of main-thread time. */
async function sliced<T>(items: T[], work: (t: T) => void, alive: () => boolean, budget = 8) {
  let i = 0
  while (i < items.length) {
    if (!alive()) return false
    await idle()
    const t0 = performance.now()
    do work(items[i++])
    while (i < items.length && performance.now() - t0 < budget)
  }
  return true
}

const drawable = (o: THREE.Object3D) =>
  (o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite

/** Every drawable in the scene except the campus (it never shows inside). */
function hallDrawables(scene: THREE.Object3D, campus: THREE.Object3D | null) {
  const out: THREE.Object3D[] = []
  const walk = (o: THREE.Object3D) => {
    if (o === campus) return
    if (drawable(o)) out.push(o)
    for (const c of o.children) walk(c)
  }
  walk(scene)
  return out
}

function texturesOf(gl: THREE.WebGLRenderer, m: THREE.Material, into: Set<THREE.Texture>) {
  const add = (v: unknown) => {
    const t = v as THREE.Texture | null
    if (!t || !t.isTexture || (t as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture) return
    const img = t.image as (HTMLImageElement & { data?: unknown }) | undefined
    if (!img || (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement && !img.complete)) return
    if (typeof HTMLVideoElement !== 'undefined' && img instanceof HTMLVideoElement) return
    into.add(t)
  }
  for (const v of Object.values(m)) add(v)
  // uniforms added in onBeforeCompile (the grain / terrazzo detail) live on the renderer's side
  const u = (gl.properties.get(m) as { uniforms?: Record<string, { value: unknown }> }).uniforms
  if (u) for (const k in u) add(u[k]?.value)
}

/**
 * Compile the hall's shaders exactly as the hall will draw them: its lights on (the hall
 * group made visible for the light count), into a float render target like the
 * post-processing's scene pass (linear output, no tone mapping). Then upload textures.
 * Sliced across idle time; returns false if cancelled.
 */
export async function compileHall(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D, campus: THREE.Object3D | null, alive: () => boolean) {
  const list = hallDrawables(scene, campus)
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
  const programs = new Set<Program>()
  const textures = new Set<THREE.Texture>()
  const chunks: THREE.Object3D[][] = []
  for (let i = 0; i < list.length; i += 32) chunks.push(list.slice(i, i + 32))
  const ok = await sliced(
    chunks,
    (part) => {
      // compile(object, camera, scene): lights come from `scene`; the stand-in object hands
      // over just this slice of drawables (and adds no lights of its own)
      const slice = { traverse: (cb: (o: THREE.Object3D) => void) => part.forEach(cb), traverseVisible: () => {} } as unknown as THREE.Object3D
      const was = root.visible
      const prev = gl.getRenderTarget()
      root.visible = true
      gl.setRenderTarget(rt)
      try {
        for (const m of gl.compile(slice, camera, scene)) {
          const p = (gl.properties.get(m) as { currentProgram?: Program }).currentProgram
          if (p) programs.add(p)
          texturesOf(gl, m, textures)
        }
      } finally {
        gl.setRenderTarget(prev)
        root.visible = was
      }
    },
    alive,
    12,
  )
  rt.dispose()
  if (!ok) return false
  // With KHR_parallel_shader_compile the driver links in the background: wait for it
  // instead of blocking. Then do each program's first-use work (link check, uniform and
  // attribute lookup) now, a few per idle slice, so the first hall frame doesn't.
  const pending = [...programs]
  for (let tries = 0; tries < 200 && pending.some((p) => p.isReady && !p.isReady()); tries++) {
    if (!alive()) return false
    await sleep(20)
  }
  if (!(await sliced(pending, (p) => (p.getUniforms(), p.getAttributes()), alive))) return false
  return sliced([...textures], (t) => gl.initTexture(t), alive)
}

/**
 * Draw one hall frame through the hall's composer, hidden: call it from a frame callback
 * that runs before the campus composer (which then draws the whole screen again).
 * Everything is drawn (no culling) so every mesh, its shadow and its geometry is ready.
 */
export function warmFrame(camera: THREE.Camera, root: THREE.Object3D, campus: THREE.Object3D | null, fx: Composer, gl: THREE.WebGLRenderer, dt: number) {
  const cam = camera as THREE.PerspectiveCamera
  const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, near: cam.near, far: cam.far }
  const rootWas = root.visible
  const campusWas = campus?.visible
  const culled: THREE.Object3D[] = []
  root.traverse((o) => {
    if (drawable(o) && o.frustumCulled) {
      o.frustumCulled = false
      culled.push(o)
    }
  })
  root.visible = true
  if (campus) campus.visible = false
  // the camera where the entrance fly-through starts (Player's intro path)
  cam.position.set(17, 3.2, 23)
  cam.lookAt(0, 3, 12)
  if (cam.isPerspectiveCamera) {
    cam.fov = 60
    cam.near = 0.1
    cam.updateProjectionMatrix()
  }
  cam.updateMatrixWorld()
  try {
    const size = gl.getSize(new THREE.Vector2())
    fx.setSize(size.x, size.y)
    fx.render(dt)
  } finally {
    for (const o of culled) o.frustumCulled = true
    root.visible = rootWas
    if (campus) campus.visible = campusWas!
    cam.position.copy(saved.p)
    cam.quaternion.copy(saved.q)
    if (cam.isPerspectiveCamera) {
      cam.fov = saved.fov
      cam.near = saved.near
      cam.far = saved.far
      cam.updateProjectionMatrix()
    }
    cam.updateMatrixWorld()
  }
}
