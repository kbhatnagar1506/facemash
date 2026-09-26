import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Draw-call batching for the atrium. The hall is ~1,700 small meshes (every chair
// leg, bin, panel and table), most of which never move. After it has loaded, the
// static opaque meshes that look identical are merged into one mesh per look, in
// world space, and the originals are hidden. Same geometry, same material, same
// shadow flags: nothing changes on screen, there are just far fewer draw calls.

type Snap = Map<THREE.Mesh, THREE.Matrix4>

/** Record where every candidate mesh is, so a later pass can tell what moved. */
export function snapshot(root: THREE.Object3D): Snap {
  root.updateMatrixWorld(true)
  const snap: Snap = new Map()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) snap.set(m, m.matrixWorld.clone())
  })
  return snap
}

function batchable(m: THREE.Mesh, root: THREE.Object3D) {
  if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return false
  if (m.userData.noBatch || Array.isArray(m.material)) return false
  const mat = m.material as THREE.Material
  // only plain lit, opaque surfaces: screens, signs, glows and glass stay as they are
  const lit =
    (mat as THREE.MeshLambertMaterial).isMeshLambertMaterial ||
    (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
    (mat as THREE.MeshToonMaterial).isMeshToonMaterial
  if (!lit || mat.transparent || mat.alphaTest > 0) return false
  if (m.geometry.morphAttributes.position) return false // (face groups are fine: one material)
  if (m.matrixWorld.determinant() <= 0) return false // mirrored parts would flip their faces
  // every ancestor below the hall root must be visible (hidden subtrees stay as they are)
  for (let p: THREE.Object3D | null = m; p && p !== root; p = p.parent) if (!p.visible) return false
  // React-controlled visibility (props.visible) must keep working, so leave those alone
  const r3f = (m as unknown as { __r3f?: { props?: Record<string, unknown> } }).__r3f
  if (r3f?.props && 'visible' in r3f.props) return false
  return true
}

/** A key that is equal only for materials that render identically. */
function lookKey(m: THREE.Mesh) {
  const mat = m.material as THREE.MeshStandardMaterial & THREE.MeshToonMaterial
  const tex = (t?: THREE.Texture | null) => (t ? t.uuid : '-')
  return [
    mat.type,
    mat.color?.getHexString(),
    mat.emissive?.getHexString(),
    mat.emissiveIntensity,
    mat.roughness,
    mat.metalness,
    tex(mat.map),
    tex(mat.normalMap),
    tex(mat.roughnessMap),
    tex(mat.gradientMap),
    mat.side,
    mat.vertexColors,
    mat.flatShading,
    mat.customProgramCacheKey?.() ?? '',
    m.castShadow,
    m.receiveShadow,
    m.renderOrder,
  ].join('|')
}

/**
 * Merge every static batchable mesh under `root` (not moved since `before`).
 * Returns how many meshes were folded into how many batches.
 */
export function batchStatic(root: THREE.Object3D, before: Snap) {
  root.updateMatrixWorld(true)
  const groups = new Map<string, THREE.Mesh[]>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !batchable(m, root)) return
    const was = before.get(m)
    if (!was || !was.equals(m.matrixWorld)) return // moving (or brand new): leave it
    const k = lookKey(m)
    let list = groups.get(k)
    if (!list) groups.set(k, (list = []))
    list.push(m)
  })
  const out = new THREE.Group()
  out.name = 'static-batches'
  let folded = 0
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const mat = list[0].material as THREE.Material
    const wantColor = (mat as THREE.MeshLambertMaterial).vertexColors
    const parts: THREE.BufferGeometry[] = []
    for (const m of list) {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()
      g.clearGroups()
      // keep just the attributes this material reads, so everything merges
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', ...(wantColor ? ['color'] : [])].includes(name)) g.deleteAttribute(name)
      if (!g.attributes.normal) g.computeVertexNormals()
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
      if (wantColor && !g.attributes.color) {
        g.dispose()
        g = null as unknown as THREE.BufferGeometry
      }
      if (!g) continue
      g.applyMatrix4(m.matrixWorld)
      parts.push(g)
    }
    const merged = parts.length > 1 ? mergeGeometries(parts) : null
    parts.forEach((p) => p.dispose())
    if (!merged) continue
    merged.computeBoundingSphere()
    const b = new THREE.Mesh(merged, mat)
    b.castShadow = list[0].castShadow
    b.receiveShadow = list[0].receiveShadow
    b.renderOrder = list[0].renderOrder
    b.matrixAutoUpdate = false
    out.add(b)
    for (const m of list) m.visible = false
    folded += list.length
  }
  // the batches live in world space: parent them at the scene root level of `root`
  root.add(out)
  out.matrixAutoUpdate = false
  const inv = root.matrixWorld.clone().invert()
  out.matrix.copy(inv)
  out.matrixWorldNeedsUpdate = true
  return { folded, batches: out.children.length }
}
