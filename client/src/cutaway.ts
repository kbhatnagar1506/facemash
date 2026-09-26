import * as THREE from 'three'

/** Player position shared by every cutaway material; Player.tsx writes it each frame. */
export const cutawayUniforms = { uPlayer: { value: new THREE.Vector3() } }

/**
 * Patch a material so geometry standing between the camera (to the south) and
 * the player is cut out, keeping the player visible behind tall buildings.
 */
export function withCutaway<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPlayer = cutawayUniforms.uPlayer
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvCutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uPlayer;\nvarying vec3 vCutWorld;',
      )
      .replace(
        'void main() {',
        `void main() {
  {
    vec2 d = vCutWorld.xz - uPlayer.xz;
    // Only cut above head height and on the camera side (south, +z) of the player.
    if (vCutWorld.y > 2.2 && d.y > -3.0) {
      float r = length(vec2(d.x, d.y * 0.55));
      if (r < 9.0) discard;
      // Dithered edge so the hole fades instead of popping.
      if (r < 13.0 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0) discard;
    }
  }`,
      )
  }
  mat.customProgramCacheKey = () => 'cutaway'
  return mat
}
