import * as THREE from 'three'

/** Player position shared by every cutaway material; Player.tsx writes it each frame. */
export const cutawayUniforms = { uPlayer: { value: new THREE.Vector3() } }

/**
 * Patch a building material with world-position info (used for the window grid).
 * (It used to cut a see-through hole around the player; that's been removed.)
 */
export function withCutaway<T extends THREE.Material>(mat: T, opts: { windows?: THREE.Color[] } = {}): T {
  const win = opts.windows
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPlayer = cutawayUniforms.uPlayer
    if (win) {
      shader.uniforms.uWallA = { value: win[0] }
      shader.uniforms.uWallB = { value: win[1] ?? win[0] }
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;\nvarying vec3 vCutN;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCutN = normalize(mat3(modelMatrix) * objectNormal);',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uPlayer;\nvarying vec3 vCutWorld;\nvarying vec3 vCutN;' +
          (win ? '\nuniform vec3 uWallA;\nuniform vec3 uWallB;' : ''),
      )
  }
  if (win) {
    // Window grid on building walls: floors every 3.6 m, a window every 2.4 m.
    const prev = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, r) => {
      prev(shader, r)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    bool isWall = abs(vCutN.y) < 0.3 && (distance(vColor.rgb, uWallA) < 0.06 || distance(vColor.rgb, uWallB) < 0.06);
    if (isWall && vCutWorld.y > 1.2) {
      vec2 t = normalize(vec2(-vCutN.z, vCutN.x));
      float h = dot(vCutWorld.xz, t);
      float fy = fract((vCutWorld.y - 1.2) / 3.6);
      float fx = fract(h / 2.4);
      float w = step(0.18, fy) * step(fy, 0.72) * step(0.14, fx) * step(fx, 0.78);
      // glass: cool blue, lighter toward the top of each pane like a sky reflection
      vec3 glass = mix(vec3(0.16, 0.26, 0.38), vec3(0.55, 0.72, 0.86), smoothstep(0.18, 0.72, fy));
      diffuseColor.rgb = mix(diffuseColor.rgb, glass, w);
      // thin sill under each window
      diffuseColor.rgb *= 1.0 - 0.25 * step(0.14, fx) * step(fx, 0.78) * step(0.12, fy) * step(fy, 0.18);
    }
  }`,
      )
    }
  }
  mat.customProgramCacheKey = () => (win ? 'cutaway-win' : 'cutaway')
  return mat
}
